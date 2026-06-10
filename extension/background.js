// background.js — CDP Bridge Extension Service Worker
// Connects to ws://localhost:9229 (cdp-ext.mjs bridge server),
// executes CDP commands via chrome.debugger API, returns results.
// Uses chrome.debugger instead of remote debugging port → only a
// non-blocking info-bar, no blocking "Allow debugging?" modal.

const BRIDGE_WS_URL = 'ws://localhost:9229';
const KEEPALIVE_MS = 15_000;
const NAV_TIMEOUT = 30_000;

// ─── State ────────────────────────────────────────────────────────────────────

let ws = null;
let wsConnected = false;
let reconnectTimer = null;
let reconnectDelay = 800; // ms, grows with backoff while the bridge is down

// targetIds we have currently attached to
const attached = new Set();

// CDP event listeners: targetId → Map(method → Set(callback))
const cdpEventListeners = new Map();

// ─── WebSocket connection ─────────────────────────────────────────────────────

function safeSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) try { ws.send(data); } catch {}
}

// Single-shot reconnect with backoff. Guarded by reconnectTimer so we never
// stack timers (this is what the old "avoid cascade" comment worried about — a
// single pending timer makes a cascade impossible). The first retry is fast
// (800ms) so a quick bridge restart recovers in ~1s; if the bridge stays down
// the delay backs off to 30s so we don't spam the extension error log with
// benign "ws://localhost:9229 ERR_CONNECTION_REFUSED" entries (Chrome logs that
// at the network layer on every attempt — it can't be caught/suppressed).
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
}

function connect() {
  // Guard: don't create a new connection if one is already open or connecting
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  // Tear down any stale socket before opening a new one. Detach its onclose
  // first so the old socket can't trigger another reconnect — this kills the
  // duplicate-connection / flapping we saw in the bridge logs.
  if (ws) { try { ws.onclose = null; ws.onmessage = null; ws.close(); } catch {} ws = null; }

  let thisWs;
  try { thisWs = new WebSocket(BRIDGE_WS_URL); } catch { scheduleReconnect(); return; }
  ws = thisWs;

  thisWs.onopen = () => {
    if (ws !== thisWs) { thisWs.close(); return; } // superseded
    wsConnected = true;
    reconnectDelay = 800; // reset backoff on a healthy connection
    console.log('[cdp-bridge] Connected to bridge at', BRIDGE_WS_URL);
  };

  thisWs.onclose = () => {
    if (ws === thisWs) { wsConnected = false; ws = null; }
    // Fast single-shot reconnect: absorbs bridge restarts within ~1s while the
    // service worker is still alive. The chrome.alarms tick (every 30s) remains
    // the backstop for when the SW has been fully suspended.
    scheduleReconnect();
  };

  thisWs.onerror = () => {};

  thisWs.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'ping') { safeSend(JSON.stringify({ type: 'pong' })); return; }

    const { id, cmd, args = [] } = msg;
    let response;
    try { response = await dispatch(cmd, args); }
    catch (e) { response = { ok: false, error: e.message }; }
    // Use safeSend — ws may have changed during the await above
    safeSend(JSON.stringify({ id, ...response }));
  };
}

// Self-healing keepalive. While the SW is alive this keeps the WebSocket warm
// (inbound/outbound WS traffic keeps the SW alive on Chrome 116+); if the socket
// has dropped it reconnects immediately instead of waiting for the 30s alarm.
// NOTE: setInterval does NOT survive SW suspension — chrome.alarms (below) is the
// real wake mechanism once the SW is asleep. This interval only covers the
// "SW still alive but socket dropped" case.
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) safeSend(JSON.stringify({ type: 'ping' }));
  else scheduleReconnect(); // respects the backoff guard — avoids racing extra connect() attempts
}, KEEPALIVE_MS);

// ─── chrome.debugger helpers ──────────────────────────────────────────────────

chrome.debugger.onDetach.addListener((source) => {
  const tid = source.targetId;
  if (tid) { attached.delete(tid); cdpEventListeners.delete(tid); }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tid = source.targetId;
  if (!tid) return;
  cdpEventListeners.get(tid)?.get(method)?.forEach(cb => cb(params));
});

async function ensureAttached(targetId) {
  if (attached.has(targetId)) return;
  try {
    await chrome.debugger.attach({ targetId }, '1.3');
  } catch (e) {
    const msg = e.message || '';
    // We're already attached from a prior call — fine, just record it.
    if (msg.includes('already attached')) { attached.add(targetId); return; }
    // Chrome allows only ONE debugger client per target. This is almost always
    // another debugger holding the tab: DevTools (F12) open, or another
    // automation extension (e.g. "Claude in Chrome", "Codex"). Surface a clear
    // hint instead of the opaque "Cannot attach to this target".
    if (msg.includes('Cannot attach')) {
      throw new Error(
        'Cannot attach to this target — another debugger already owns this tab. ' +
        'Close its DevTools (F12) or disable other browser-automation extensions ' +
        '(Claude in Chrome / Codex), then retry.'
      );
    }
    throw e;
  }
  attached.add(targetId);
}

function cdpSend(targetId, method, params = {}) {
  return chrome.debugger.sendCommand({ targetId }, method, params);
}

function waitForCdpEvent(targetId, method, timeout = NAV_TIMEOUT) {
  if (!cdpEventListeners.has(targetId)) cdpEventListeners.set(targetId, new Map());
  const methods = cdpEventListeners.get(targetId);
  if (!methods.has(method)) methods.set(method, new Set());
  const cbs = methods.get(method);

  let cb, timer, resolveOuter, rejectOuter;
  const promise = new Promise((res, rej) => {
    resolveOuter = res; rejectOuter = rej;
    timer = setTimeout(() => { cbs.delete(cb); rej(new Error(`Timeout: ${method}`)); }, timeout);
    cb = (params) => { clearTimeout(timer); cbs.delete(cb); res(params); };
    cbs.add(cb);
  });
  const cancel = () => { clearTimeout(timer); cbs.delete(cb); resolveOuter(null); };
  return { promise, cancel };
}

async function evalJs(targetId, expression) {
  const r = await cdpSend(targetId, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text || r.exceptionDetails.exception?.description || 'JS exception');
  }
  return r.result?.value;
}

// ─── Command implementations ──────────────────────────────────────────────────

async function cmdList() {
  const targets = await chrome.debugger.getTargets();
  const pages = targets.filter(t =>
    t.type === 'page' &&
    !t.url.startsWith('chrome://') &&
    !t.url.startsWith('chrome-extension://')
  );

  const ids = pages.map(p => p.id);
  let prefixLen = 8;
  for (let len = 8; len <= 36; len++) {
    if (new Set(ids.map(id => id.slice(0, len).toUpperCase())).size === ids.length) {
      prefixLen = len; break;
    }
  }

  const lines = pages.map(p => {
    const id = p.id.slice(0, prefixLen).padEnd(prefixLen);
    const title = (p.title || '').substring(0, 54).padEnd(54);
    return `${id}  ${title}  ${p.url}`;
  });

  // Return pages list for cache update in bridge
  const pagesMeta = pages.map(p => ({ targetId: p.id, title: p.title || '', url: p.url }));
  return { ok: true, result: lines.join('\n'), pages: pagesMeta };
}

async function cmdSnap(targetId) {
  await ensureAttached(targetId);
  const { nodes } = await cdpSend(targetId, 'Accessibility.getFullAXTree');
  return { ok: true, result: formatAxTree(nodes, true) };
}

async function cmdEval(targetId, expression) {
  await ensureAttached(targetId);
  const val = await evalJs(targetId, expression);
  return { ok: true, result: typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '') };
}

async function cmdShot(targetId) {
  await ensureAttached(targetId);
  let dpr = 1;
  try {
    const v = await evalJs(targetId, 'window.devicePixelRatio');
    const p = parseFloat(v);
    if (p > 0) dpr = p;
  } catch {}
  const { data } = await cdpSend(targetId, 'Page.captureScreenshot', { format: 'png' });
  return { ok: true, screenshot: data, dpr };
}

async function cmdHtml(targetId, selector) {
  await ensureAttached(targetId);
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : 'document.documentElement.outerHTML';
  const val = await evalJs(targetId, expr);
  return { ok: true, result: String(val ?? '') };
}

async function cmdNav(targetId, url) {
  try {
    const p = new URL(url);
    if (p.protocol !== 'http:' && p.protocol !== 'https:')
      throw new Error(`Only http/https URLs allowed, got: ${url}`);
  } catch (e) {
    if (e.message.startsWith('Only')) throw e;
    throw new Error(`Invalid URL: ${url}`);
  }

  await ensureAttached(targetId);
  await cdpSend(targetId, 'Page.enable');

  const loadEvent = waitForCdpEvent(targetId, 'Page.loadEventFired', NAV_TIMEOUT);
  const result = await cdpSend(targetId, 'Page.navigate', { url });

  if (result.errorText) { loadEvent.cancel(); throw new Error(result.errorText); }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }

  // Poll readyState up to 5s
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const state = await evalJs(targetId, 'document.readyState');
      if (state === 'complete') break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  return { ok: true, result: `Navigated to ${url}` };
}

async function cmdNet(targetId) {
  await ensureAttached(targetId);
  const val = await evalJs(targetId,
    `JSON.stringify(performance.getEntriesByType('resource').map(e=>({` +
    `name:e.name.substring(0,120),type:e.initiatorType,duration:Math.round(e.duration),size:e.transferSize})))`
  );
  const entries = JSON.parse(val ?? '[]');
  const lines = entries.map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  );
  return { ok: true, result: lines.join('\n') };
}

async function cmdClick(targetId, selector) {
  if (!selector) throw new Error('CSS selector required');
  await ensureAttached(targetId);
  const expr = `(function(){` +
    `const el=document.querySelector(${JSON.stringify(selector)});` +
    `if(!el)return{ok:false,error:'Element not found: '+${JSON.stringify(selector)}};` +
    `el.scrollIntoView({block:'center'});el.click();` +
    `return{ok:true,tag:el.tagName,text:el.textContent.trim().substring(0,80)};` +
    `})()`;
  const r = await evalJs(targetId, expr);
  if (!r?.ok) throw new Error(r?.error || 'Click failed');
  return { ok: true, result: `Clicked <${r.tag}> "${r.text}"` };
}

async function cmdClickXy(targetId, x, y) {
  const cx = parseFloat(x), cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  await ensureAttached(targetId);
  const base = { x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 };
  await cdpSend(targetId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
  await cdpSend(targetId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await new Promise(r => setTimeout(r, 50));
  await cdpSend(targetId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  return { ok: true, result: `Clicked at CSS (${cx}, ${cy})` };
}

async function cmdType(targetId, text) {
  if (text == null || text === '') throw new Error('text required');
  await ensureAttached(targetId);
  await cdpSend(targetId, 'Input.insertText', { text });
  return { ok: true, result: `Typed ${text.length} characters` };
}

async function cmdLoadAll(targetId, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  await ensureAttached(targetId);
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const exists = await evalJs(targetId, `!!document.querySelector(${JSON.stringify(selector)})`);
    if (!exists) break;
    const clicked = await evalJs(targetId,
      `(function(){const el=document.querySelector(${JSON.stringify(selector)});` +
      `if(!el)return false;el.scrollIntoView({block:'center'});el.click();return true;})()` );
    if (!clicked) break;
    clicks++;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { ok: true, result: `Clicked "${selector}" ${clicks} time(s) until it disappeared` };
}

async function cmdEvalRaw(targetId, method, paramsJson) {
  if (!method) throw new Error('CDP method required');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  await ensureAttached(targetId);
  const result = await cdpSend(targetId, method, params);
  return { ok: true, result: JSON.stringify(result, null, 2) };
}

async function cmdOpen(url) {
  url = url || 'about:blank';
  const tab = await chrome.tabs.create({ url });
  return { ok: true, result: `Opened new tab: ${tab.id}  ${url}` };
}

// ─── Accessibility tree formatting ───────────────────────────────────────────

function formatAxTree(nodes, compact = false) {
  const nodesById = new Map(nodes.map(n => [n.nodeId, n]));
  const childrenByParent = new Map();
  for (const n of nodes) {
    if (!n.parentId) continue;
    if (!childrenByParent.has(n.parentId)) childrenByParent.set(n.parentId, []);
    childrenByParent.get(n.parentId).push(n);
  }

  const lines = [];
  const visited = new Set();

  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    const role = node.role?.value || '';
    const name = node.name?.value ?? '';
    const value = node.value?.value;
    const skip = role === 'none' || role === 'generic' || (name === '' && (value === '' || value == null));
    if (!skip && !(compact && role === 'InlineTextBox')) {
      const indent = '  '.repeat(Math.min(depth, 10));
      let line = `${indent}[${role}]`;
      if (name !== '') line += ` ${name}`;
      if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
      lines.push(line);
    }
    const seen = new Set();
    for (const childId of node.childIds || []) {
      const child = nodesById.get(childId);
      if (child && !seen.has(child.nodeId)) { seen.add(child.nodeId); visit(child, depth + 1); }
    }
    for (const child of childrenByParent.get(node.nodeId) || []) {
      if (!seen.has(child.nodeId)) { seen.add(child.nodeId); visit(child, depth + 1); }
    }
  }

  const roots = nodes.filter(n => !n.parentId || !nodesById.has(n.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);
  return lines.join('\n');
}

// ─── Command dispatcher ───────────────────────────────────────────────────────

async function dispatch(cmd, args) {
  switch (cmd) {
    case 'list':                        return cmdList();
    case 'snap': case 'snapshot':       return cmdSnap(args[0]);
    case 'eval':                        return cmdEval(args[0], args[1]);
    case 'shot': case 'screenshot':     return cmdShot(args[0]);
    case 'html':                        return cmdHtml(args[0], args[1]);
    case 'nav':  case 'navigate':       return cmdNav(args[0], args[1]);
    case 'net':  case 'network':        return cmdNet(args[0]);
    case 'click':                       return cmdClick(args[0], args[1]);
    case 'clickxy':                     return cmdClickXy(args[0], args[1], args[2]);
    case 'type':                        return cmdType(args[0], args[1]);
    case 'loadall':                     return cmdLoadAll(args[0], args[1], args[2] ? parseInt(args[2]) : 1500);
    case 'evalraw':                     return cmdEvalRaw(args[0], args[1], args[2]);
    case 'open':                        return cmdOpen(args[0]);
    default:                            return { ok: false, error: `Unknown command: ${cmd}` };
  }
}

// ─── Popup messaging ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'status') {
    sendResponse({
      wsConnected,
      bridgeUrl: BRIDGE_WS_URL,
      attachedCount: attached.size,
      attachedTargets: [...attached],
    });
  }
  return false;
});

// ─── Init ─────────────────────────────────────────────────────────────────────

// Use chrome.alarms to periodically wake the service worker and reconnect.
// setTimeout-based retries don't survive service worker sleep cycles.
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 }); // every 30s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reconnect' && !wsConnected) connect();
});

// Also try on install / Chrome startup
chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());

connect();
