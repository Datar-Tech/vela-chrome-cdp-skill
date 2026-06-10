#!/usr/bin/env node
// cdp-ext — CDP CLI via Chrome Extension (no remote debugging port needed)
// Drop-in replacement for cdp.mjs.
// Architecture:
//   cdp-ext.mjs [cmd]  ←─ named-pipe ─→  bridge daemon
//                                              ↕ WebSocket (localhost:9229)
//                                         Chrome Extension (background.js)
//                                              ↕ chrome.debugger API
//                                         Chrome tabs (info-bar only, no modal)

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { spawn } from 'child_process';
import net from 'net';
import { WebSocketServer } from 'ws';

const IS_WINDOWS = process.platform === 'win32';
const RUNTIME_DIR = IS_WINDOWS
  ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'cdp-ext')
  : resolve(homedir(), '.cache', 'cdp-ext');
const PAGES_CACHE = resolve(RUNTIME_DIR, 'pages.json');
const BRIDGE_SOCK  = IS_WINDOWS ? '\\\\.\\pipe\\cdp-ext-bridge' : resolve(RUNTIME_DIR, 'bridge.sock');
const WS_PORT      = 9229;
const CMD_TIMEOUT  = 35_000;
const DAEMON_RETRIES = 20;
const DAEMON_DELAY   = 300;
const MIN_PREFIX_LEN = 8;

try { mkdirSync(RUNTIME_DIR, { recursive: true }); } catch {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Prefix resolution (same as cdp.mjs) ────────────────────────────────────

function resolvePrefix(prefix, candidates, noun = 'target', hint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(c => c.toUpperCase().startsWith(upper));
  if (matches.length === 0) throw new Error(`No ${noun} matching prefix "${prefix}".${hint ? ' ' + hint : ''}`);
  if (matches.length > 1)  throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  return matches[0];
}

// WebSocket server uses the 'ws' npm package for reliable Chrome compatibility.

// ─── Bridge daemon ───────────────────────────────────────────────────────────

async function runBridge() {
  let extWs = null;       // WebSocket connection to extension
  const pending = new Map(); // msgId → {resolve, reject, timer}
  let msgIdCounter = 0;

  function sendToExt(msg) {
    if (!extWs || extWs.readyState !== 1) return false;
    extWs.send(JSON.stringify(msg));
    return true;
  }

  function extCmd(cmd, args) {
    return new Promise((resolve, reject) => {
      if (!extWs || extWs.readyState !== 1) {
        return reject(new Error('Extension not connected. Load the extension in Chrome, then retry.'));
      }
      const id = String(++msgIdCounter);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Command timed out: ${cmd}`));
      }, CMD_TIMEOUT);
      pending.set(id, { resolve, reject, timer });
      sendToExt({ id, cmd, args });
    });
  }

  // Handle a message from CLI (via named-pipe socket)
  async function handleCliCmd({ cmd, args = [] }) {
    if (cmd === 'stop') return { ok: true, result: '', stopAfter: true };

    try {
      const extResp = await extCmd(cmd, args);
      return extResp;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ── WebSocket server for Extension (using 'ws' package) ─────────────────────

  const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

  wss.on('listening', () => {
    process.stderr.write(`[cdp-ext bridge] WebSocket server listening on ws://127.0.0.1:${WS_PORT}\n`);
  });

  wss.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      // Another bridge already owns the singleton port. The bridge is a
      // machine-wide singleton by design (one Chrome extension ↔ one bridge),
      // so this process is just the loser of a spawn race — exit quietly and
      // let the CLI connect to the existing bridge instead of crashing.
      process.stderr.write(`[cdp-ext bridge] Another bridge already running on :${WS_PORT}; exiting.\n`);
      process.exit(0);
    }
    process.stderr.write(`[cdp-ext bridge] WS server error: ${e.message}\n`);
    process.exit(1);
  });

  wss.on('connection', (ws) => {
    process.stderr.write(`[bridge] Extension connected\n`);

    // If extension reconnects, close old socket
    if (extWs && extWs.readyState === 1) extWs.close();
    extWs = ws;

    // Ping extension every 10s to keep Chrome service worker alive
    const pingTimer = setInterval(() => {
      if (ws.readyState !== 1) { clearInterval(pingTimer); return; }
      ws.send(JSON.stringify({ type: 'ping' }));
    }, 10_000);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (msg.type === 'pong') return;

      if (msg.id && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(timer);
        resolve(msg);
      }
    });

    ws.on('close', () => {
      process.stderr.write(`[bridge] Extension disconnected\n`);
      clearInterval(pingTimer);
      if (extWs === ws) extWs = null;
    });

    ws.on('error', () => {});
  });

  const wsServer = wss; // alias for shutdown

  // ── Named-pipe / Unix-socket server for CLI ─────────────────────────────────

  // Shutdown
  function shutdown() {
    wsServer.close();
    cliServer.close();
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const cliServer = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try { req = JSON.parse(line); } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON', id: null }) + '\n'); continue;
        }

        handleCliCmd(req).then(async (res) => {
          // Special handling: screenshot returns base64 data → write file here
          if (res.ok && res.screenshot) {
            const targetId = req.args?.[0] || 'unknown';
            const filePath = req.args?.[1] || resolve(RUNTIME_DIR, `screenshot-${targetId.slice(0, 8)}.png`);
            writeFileSync(filePath, Buffer.from(res.screenshot, 'base64'));
            const dpr = res.dpr || 1;
            const info = [
              filePath,
              `Screenshot saved. Device pixel ratio (DPR): ${dpr}`,
              `Coordinate mapping:`,
              `  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`,
              `  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`,
            ];
            if (dpr !== 1) info.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
            res = { ok: true, result: info.join('\n') };
          }

          // pages returned by list → update cache. Never clobber the cache with
          // an empty list: that happens transiently while the extension is
          // reconnecting, and would wipe targetIds that are still valid.
          if (res.ok && Array.isArray(res.pages) && res.pages.length) {
            try { writeFileSync(PAGES_CACHE, JSON.stringify(res.pages)); } catch {}
          }

          const payload = JSON.stringify({ ok: res.ok, result: res.result, error: res.error, id: req.id }) + '\n';
          if (res.stopAfter) { conn.end(payload, shutdown); }
          else conn.write(payload);
        });
      }
    });
    conn.on('error', () => {});
  });

  cliServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      // Loser of a spawn race on the named pipe — another bridge owns it. Exit
      // quietly; the CLI will connect to the existing bridge.
      process.stderr.write(`[cdp-ext bridge] Another bridge already owns the CLI socket; exiting.\n`);
      process.exit(0);
    }
    process.stderr.write(`[cdp-ext bridge] CLI server error: ${e.message}\n`);
    process.exit(1);
  });

  if (!IS_WINDOWS) { try { unlinkSync(BRIDGE_SOCK); } catch {} }
  cliServer.listen(BRIDGE_SOCK);
  process.stderr.write(`[cdp-ext bridge] CLI socket listening on ${BRIDGE_SOCK}\n`);
  process.stderr.write(`[cdp-ext bridge] Load the extension in Chrome (extension/ directory), then run commands.\n`);
}

// ─── CLI ↔ bridge IPC ────────────────────────────────────────────────────────

function connectToBridge() {
  return new Promise((resolve, reject) => {
    const conn = net.connect(BRIDGE_SOCK);
    conn.on('connect', () => resolve(conn));
    conn.on('error', reject);
  });
}

async function getOrStartBridge() {
  try { return await connectToBridge(); } catch {}

  // Spawn bridge daemon
  const child = spawn(process.execPath, [process.argv[1], '_bridge'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  for (let i = 0; i < DAEMON_RETRIES; i++) {
    await sleep(DAEMON_DELAY);
    try { return await connectToBridge(); } catch {}
  }
  throw new Error('Bridge failed to start. Try: node cdp-ext.mjs serve');
}

function sendCliCmd(conn, req) {
  return new Promise((resolve, reject) => {
    let buf = ''; let settled = false;
    const cleanup = () => { conn.off('data', onData); conn.off('error', onErr); conn.off('end', onEnd); };
    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n'); if (idx === -1) return;
      settled = true; cleanup(); resolve(JSON.parse(buf.slice(0, idx))); conn.end();
    };
    const onErr = (e) => { if (settled) return; settled = true; cleanup(); reject(e); };
    const onEnd = () => { if (settled) return; settled = true; cleanup(); reject(new Error('Bridge closed connection')); };
    conn.on('data', onData); conn.on('error', onErr); conn.on('end', onEnd);
    req.id = 1;
    conn.write(JSON.stringify(req) + '\n');
  });
}

// ─── Resilience: auto-retry transient failures ───────────────────────────────
// These errors are all symptoms of the bridge restarting or the extension's MV3
// service worker reconnecting (a 0–30s window). They are transient, so the CLI
// absorbs them with a few short retries instead of failing the user's command.
const TRANSIENT = /Extension not connected|Cannot attach to this target|another debugger already owns|No target with given id|Bridge closed connection|Bridge unavailable|Command timed out|ECONNREFUSED|EPIPE/i;

// Send one command, opening a fresh bridge connection each attempt.
async function sendOnce(req) {
  let conn;
  try { conn = await getOrStartBridge(); }
  catch (e) { return { ok: false, error: `Bridge unavailable: ${e.message}` }; }
  try { return await sendCliCmd(conn, req); }
  catch (e) { return { ok: false, error: e.message }; }
}

// Send with retry on transient errors. `attempts` total tries, short backoff.
async function sendWithRetry(req, attempts = 4) {
  let last = { ok: false, error: 'unknown error' };
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(500 * i); // 0, 500, 1000, 1500ms
    last = await sendOnce(req);
    if (last.ok) return last;
    if (!TRANSIENT.test(last.error || '')) return last; // permanent → stop early
  }
  return last;
}

// Refresh the page cache by running a live `list` (bridge writes the cache on
// success, but only when non-empty). Returns the parsed pages or [].
async function refreshPages() {
  await sendWithRetry({ cmd: 'list', args: [] }, 4);
  try { return JSON.parse(readFileSync(PAGES_CACHE, 'utf8')); } catch { return []; }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const USAGE = `cdp-ext — CDP CLI via Chrome Extension (no remote debugging port)

Usage: cdp-ext <command> [args]

  list                              List open pages (no remote debugging needed)
  snap  <target>                    Accessibility tree snapshot
  eval  <target> <expr>             Evaluate JS expression
  shot  <target> [file]             Screenshot; prints coordinate mapping
  html  <target> [selector]         Get HTML (full page or CSS selector)
  nav   <target> <url>              Navigate to URL and wait for load
  net   <target>                    Network performance entries
  click   <target> <selector>       Click element by CSS selector
  clickxy <target> <x> <y>          Click at CSS pixel coordinates
  type    <target> <text>           Type text at current focus
  loadall <target> <selector> [ms]  Repeatedly click "load more" until gone
  evalraw <target> <method> [json]  Send raw CDP command; returns JSON
  open  [url]                       Open new tab
  stop                              Stop bridge daemon

  serve                             Start bridge daemon in foreground (for debugging)

<target> is a unique targetId prefix from "cdp-ext list".

SETUP
  1. Open Chrome → chrome://extensions → Enable Developer mode
  2. Load unpacked → select the extension/ directory
  3. The bridge starts automatically on first command (or run: node cdp-ext.mjs serve)
  4. A non-blocking info-bar appears when a tab is debugged — no blocking dialog.

COORDINATE SYSTEM
  CSS pixels = screenshot image pixels / DPR
  shot prints the DPR and an example conversion for the current page.
`;

const NEEDS_TARGET = new Set([
  'snap','snapshot','eval','shot','screenshot','html',
  'nav','navigate','net','network','click','clickxy',
  'type','loadall','evalraw',
]);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === '_bridge') { await runBridge(); return; }
  if (cmd === 'serve')   { await runBridge(); return; }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE); process.exit(0);
  }

  if (cmd === 'stop') {
    try {
      const conn = await connectToBridge();
      await sendCliCmd(conn, { cmd: 'stop', args: [] });
    } catch { /* already stopped */ }
    return;
  }

  if (cmd === 'open') {
    const res = await sendWithRetry({ cmd: 'open', args: [rest[0] || 'about:blank'] });
    if (res.ok) { if (res.result) console.log(res.result); }
    else { console.error('Error:', res.error); process.exitCode = 1; }
    return;
  }

  if (cmd === 'list' || cmd === 'ls') {
    const res = await sendWithRetry({ cmd: 'list', args: [] });
    if (res.ok) { if (res.result) console.log(res.result); }
    else { console.error('Error:', res.error); process.exitCode = 1; }
    return;
  }

  if (!NEEDS_TARGET.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`); console.log(USAGE); process.exit(1);
  }

  const targetPrefix = rest[0];
  if (!targetPrefix) { console.error('Error: target ID required. Run "cdp-ext list" first.'); process.exit(1); }

  const cmdArgs = rest.slice(1);

  // Normalise args (same rules as cdp.mjs)
  if (cmd === 'eval') {
    const expr = cmdArgs.join(' ');
    if (!expr) { console.error('Error: expression required'); process.exit(1); }
    cmdArgs[0] = expr;
    cmdArgs.length = 1;
  } else if (cmd === 'type') {
    const text = cmdArgs.join(' ');
    if (!text) { console.error('Error: text required'); process.exit(1); }
    cmdArgs[0] = text;
    cmdArgs.length = 1;
  } else if (cmd === 'evalraw') {
    if (!cmdArgs[0]) { console.error('Error: CDP method required'); process.exit(1); }
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  }

  if ((cmd === 'nav' || cmd === 'navigate') && !cmdArgs[0]) {
    console.error('Error: URL required'); process.exit(1);
  }

  // Resolve the target prefix and run the command, retrying through the
  // bridge/extension reconnect window. On a stale or missing cache (e.g. the
  // page navigated and its targetId changed) we refresh the page list live and
  // re-resolve, so the user doesn't have to manually re-run "list".
  let pages = [];
  try { pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8')); } catch {}

  const ATTEMPTS = 4;
  let lastErr = `No target matching prefix "${targetPrefix}".`;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    // Refresh the page list live if the cache is empty, or on any retry.
    if (!pages.length || attempt > 0) pages = await refreshPages();

    let targetId;
    try {
      targetId = resolvePrefix(targetPrefix, pages.map(p => p.targetId), 'target', 'Run "cdp-ext list".');
    } catch (e) {
      lastErr = e.message;
      if (/Ambiguous/.test(e.message)) break; // user must disambiguate — don't retry
      continue; // stale/missing → next loop refreshes and retries
    }

    // Always send full targetId as first arg so extension knows which tab.
    const response = await sendOnce({ cmd, args: [targetId, ...cmdArgs] });
    if (response.ok) { if (response.result) console.log(response.result); return; }

    lastErr = response.error;
    if (!TRANSIENT.test(response.error || '')) break; // permanent error → stop
    await sleep(500 * (attempt + 1));
    pages = []; // force a live refresh next loop
  }

  console.error('Error:', lastErr);
  process.exitCode = 1;
}

main().catch(e => { console.error(e.message); process.exit(1); });
