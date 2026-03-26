async function refresh() {
  const dot = document.getElementById('dot');
  const statusEl = document.getElementById('status');
  const attachedEl = document.getElementById('attached');
  const targetsSection = document.getElementById('targets-section');
  const targetsList = document.getElementById('targets-list');

  try {
    const s = await chrome.runtime.sendMessage({ type: 'status' });

    dot.className = 'dot ' + (s.wsConnected ? 'green' : 'red');
    statusEl.textContent = s.wsConnected ? `Connected (${s.bridgeUrl})` : 'Disconnected — start cdp-ext.mjs serve';
    attachedEl.textContent = `${s.attachedCount} tab${s.attachedCount !== 1 ? 's' : ''}`;

    if (s.attachedTargets.length > 0) {
      targetsSection.style.display = 'block';
      targetsList.innerHTML = s.attachedTargets
        .map(id => `<span class="target-id">${id}</span>`)
        .join('');
    } else {
      targetsSection.style.display = 'none';
    }
  } catch {
    dot.className = 'dot red';
    statusEl.textContent = 'Extension error';
    attachedEl.textContent = '—';
  }
}

refresh();
