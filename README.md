# Vela-chrome-cdp

Let your AI agent see and interact with your **live Chrome session** — the tabs you already have open, your logged-in accounts, your current page state. No browser automation framework, no separate browser instance, no re-login.

Uses a Chrome Extension with the `chrome.debugger` API — no remote debugging port, no blocking "Allow debugging?" modals. A non-blocking info bar appears briefly when a tab is first accessed.

## Why this matters

Most browser automation tools launch a fresh, isolated browser. This one connects to the Chrome you're already running, so your agent can:

- Read pages you're logged into (Gmail, GitHub, internal tools, ...)
- Interact with tabs you're actively working in
- See the actual state of a page mid-workflow, not a clean reload

## Advantages over alternatives

### Lightest context footprint of any browser automation skill

As a Claude Code skill, `vela-chrome-cdp` loads at just **~683 tokens** — a tiny fraction of your context window. Compare:

| Tool | Context cost |
|---|---|
| **vela-chrome-cdp** (this skill) | ~683 tokens |
| Chrome DevTools MCP | ~10× more (reported 93% higher by agent-browser benchmarks) |
| Playwright MCP | Heavy — MCP schema + Playwright tool definitions |
| agent-browser | Larger tool surface → more tokens per session |

This matters for long coding sessions: browser automation shouldn't eat your context budget.

### Connects to your live Chrome — by design

Most automation tools (Playwright MCP, Browser Use, Stagehand) launch a fresh isolated browser. You lose your logins, your tabs, your page state. `vela-chrome-cdp` was built from day one to attach to the Chrome you're already running:

- No relaunching Chrome, no `--remote-debugging-port` flag
- Your logged-in sessions (Gmail, GitHub, internal tools) are immediately accessible
- Works with your normal Chrome profile
- Uses `chrome.debugger` extension API — no blocking "Allow debugging?" modal, just a non-blocking info bar

### Minimal dependencies, handles 100+ tabs

- **Only dependency:** Node.js 22+ (no Puppeteer, no Playwright, no browser binaries)
- Reliably enumerates and connects to 100+ open tabs (tools built on Puppeteer often timeout during target enumeration)
- Raw CDP over WebSocket — no abstraction layers adding latency or unpredictability

### Built for coding agents

Commands map directly to what AI agents need: `list`, `shot`, `snap`, `eval`, `click`, `type`. The `snap` command returns a semantic accessibility tree — compact, structured, no vision model required. Designed as a Claude Code skill for tight terminal → browser loops.

## Setup

### 1. Install the extension

1. Open Chrome → `chrome://extensions` → enable **Developer mode**
2. Click **Load unpacked** → select the `extension/` directory from this repo

No Chrome relaunch needed. The extension connects automatically on first use.

### 2. Install dependencies

```bash
npm install
```

### As a Claude Code skill

Copy the `skills/vela-chrome-cdp/` directory into your project's `.claude/skills/`:

```bash
cp -r skills/vela-chrome-cdp/ /your/project/.claude/skills/vela-chrome-cdp/
```

Claude Code will automatically load the skill and the `/vela-chrome-cdp` slash command will be available in your project.

## Usage

```bash
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs list                              # list open tabs
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs shot   <target>                   # screenshot → runtime dir
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs snap   <target>                   # accessibility tree (compact, semantic)
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs html   <target> [selector]        # full HTML or scoped to CSS selector
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs eval   <target> "expr"            # evaluate JS in page context
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs nav    <target> https://...       # navigate and wait for load
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs net    <target>                   # network resource timing
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs click  <target> "selector"        # click element by CSS selector
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs clickxy <target> <x> <y>          # click at CSS pixel coordinates
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs type   <target> "text"            # type at focused element (works in cross-origin iframes)
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs loadall <target> "selector"       # click "load more" until gone
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs open   [url]                      # open new tab
node .claude/skills/vela-chrome-cdp/scripts/cdp-ext.mjs stop                              # stop bridge daemon
```

`<target>` is a unique prefix of the targetId shown by `list`.

## How it works

```
AI agent CLI
     ↓  named pipe
Bridge daemon (auto-started on first command)
     ↓  WebSocket ws://127.0.0.1:9229
Chrome Extension (background service worker)
     ↓  chrome.debugger API
Your Chrome tabs
```

The bridge daemon starts automatically on the first command and stays alive in the background. The Chrome extension connects to it via WebSocket and executes CDP commands using `chrome.debugger` — no remote debugging port required.

## Why not remote debugging port?

The traditional `--remote-debugging-port=9222` approach requires relaunching Chrome with a special flag, shows a blocking "Allow debugging?" modal on every new tab connection, and exposes all tabs to any local process without consent UI.

The extension approach needs no relaunch, shows only a non-blocking info bar, and works with your normal Chrome profile and all your existing sessions.
