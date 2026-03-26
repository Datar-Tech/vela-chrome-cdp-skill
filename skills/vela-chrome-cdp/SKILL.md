---
name: vela-chrome-cdp
description: Interact with local Chrome browser session (only on explicit user approval after being asked to inspect, debug, or interact with a page open in Chrome)
---

# Chrome CDP

Lightweight Chrome DevTools Protocol CLI via Chrome Extension. Connects to your live Chrome session using the `chrome.debugger` Extension API — no remote debugging port, no blocking "Allow debugging?" dialogs. A non-blocking info bar appears when a tab is first debugged.

## Prerequisites

1. Node.js (any recent version) + install dependencies: `npm install` in the skill directory
2. Open Chrome → `chrome://extensions` → enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` directory in this skill's root
4. Run any command — the bridge daemon starts automatically

## Commands

All commands use `skills/vela-chrome-cdp/scripts/cdp-ext.mjs`. The `<target>` is a **unique** targetId prefix from `list`.

### List open pages

```bash
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs list
```

### Take a screenshot

```bash
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs shot <target> [file]    # default: screenshot-<target>.png in runtime dir
```

Captures the **viewport only**. Output includes the page's DPR and coordinate conversion hint (see **Coordinates** below).

### Accessibility tree snapshot

```bash
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs snap <target>
```

### Evaluate JavaScript

```bash
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs eval <target> <expr>
```

### Other commands

```bash
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs html    <target> [selector]   # full page or element HTML
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs nav     <target> <url>         # navigate and wait for load
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs net     <target>               # resource timing entries
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs click   <target> <selector>    # click element by CSS selector
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs clickxy <target> <x> <y>       # click at CSS pixel coords
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs type    <target> <text>         # Input.insertText at current focus
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms)
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs open    [url]                  # open new tab
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs stop                           # stop bridge daemon
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical HiDPI (DPR=2): divide screenshot coords by 2.

## Tips

- Prefer `snap` over `html` for page structure — it's semantic and much more compact.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- The bridge daemon starts automatically and stays alive. A non-blocking yellow info bar appears in Chrome when a tab is first attached.
- Run `node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs serve` to see bridge logs in the foreground (useful for debugging).
- `eval` expressions can be multi-word: `node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs eval <target> document.title`
