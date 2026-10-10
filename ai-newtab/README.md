# AI New Tab ("The Morning Tab")

A Chrome new-tab page that Claude rebuilds from what you actually read. Each build, an agent looks at your ranked browsing history, opens up to eight of the pages you follow in a background window (signed in, as you), reads the cleaned HTML, and writes a single React component that becomes your new tab: a newspaper, a dashboard, a terminal, whatever you describe.

There is no server. The extension talks to the Anthropic API with your own key, and each build is one [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) session that is deleted, along with the uploaded pages, when the build ends.

This is an independent implementation written to the published description of [ThariqS/ai-newtab](https://github.com/ThariqS/ai-newtab); it does not copy that repository's code.

## Setup

Requires Node.js 20+, Chrome or another Chromium browser, and an Anthropic API key with Managed Agents access.

```bash
cd ai-newtab
npx pnpm@10.11.1 install
npx pnpm@10.11.1 build
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `ai-newtab/apps/extension/.output/chrome-mv3`.
2. Open a new tab, paste your API key, and click **Build today's homepage**. A build takes a few minutes; you can close the tab while it runs.
3. Optional: open **Settings** (gear, bottom right) to write Instructions, pick a model, and turn on automatic rebuilds.

## Settings

| Setting | What it does |
| --- | --- |
| Instructions | Free text passed to the agent each build: layout, style, what to include, what to skip. Overrides the default look, never the link or safety rules. |
| Model | Claude Sonnet 5.5 (default), Claude Haiku 5.5, or Claude Opus 5.5. Applied per session; no agent re-creation. |
| Rebuild automatically | Off, 6, 12, 24 or 48 hours. Uses `chrome.alarms` and starts after the first successful build. |
| API key | Stored in `chrome.storage.local`. "Forget key" removes it. |

Instruction ideas:

- "A morning newspaper. Serif type, big masthead, lead story, column of briefs."
- "One calm column. No images. Five things worth reading, one line on why each matters."
- "Dense dashboard: GitHub PRs first, then Hacker News, then everything else in compact cards."
- "Green-on-black terminal, monospace, every item numbered like a command listing."
- "Skip sports and politics. Always show weather and my next three calendar events." (The agent only shows these if it finds them on a page you visit; it will not make them up.)

## Cost

One build is one Managed Agents session: model tokens for reading up to eight cleaned pages and writing one component, plus session runtime. Expect well under a dollar on Sonnet 5.5, a fraction of that on Haiku 5.5, and more on Opus 5.5. Automatic rebuilds multiply this by builds per day.

## Privacy and limits

- Each build sends Anthropic a ranked summary of your recent history (domains, visit counts, a few titles and URLs) and the cleaned HTML of the pages the agent picks (at most 8), under your key. The session, the uploaded pages and the generated output file are deleted when the build finishes.
- Pages load in your signed-in browser, so private content you can see (dashboards, notifications, feeds) can end up on the homepage and in the session.
- Search engines, webmail, banking and payments, password managers, login/account pages, local addresses, and non-web URLs are filtered out of history and refused by the scraper (`packages/agent-core/src/history.ts`).
- The API key sits in extension storage. Anyone with access to this browser profile can read it.
- The generated component runs in a manifest-sandboxed iframe: an opaque origin with no `chrome.*` APIs (it cannot read the key or your history) and a CSP with `connect-src 'none'` (it cannot make network requests). Images may load over https.
- Experimental. Do not publish this extension to the Chrome Web Store as-is.

## Repository layout

```
ai-newtab/
  apps/extension/        WXT + React MV3 extension
    entrypoints/
      background.ts        service worker: message + alarm handlers
      newtab/              new-tab UI: onboarding, control bar, progress, settings
      renderer.sandbox/    sandboxed iframe that compiles and renders the TSX
    lib/
      build.ts             build lifecycle, keep-alive, resume, scheduling
      history.ts           chrome.history -> ranked summary
      scraper.ts           background window + content extraction
      storage.ts           typed chrome.storage.local
      protocol.ts          message types
  packages/agent-core/   host-agnostic agent: prompts, tool schemas, setup, orchestrator
  harness/               run builds from Node; offline orchestrator tests
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the event flow.

## Development

```bash
npx pnpm@10.11.1 dev          # WXT dev mode with reload
npx pnpm@10.11.1 typecheck    # all packages
npx pnpm@10.11.1 --filter @ai-newtab/harness test   # offline orchestrator tests (no API calls)

# A real build from Node, with fixture history and logged-out fetches:
ANTHROPIC_API_KEY=sk-ant-... npx pnpm@10.11.1 harness -- --model claude-haiku-5-5 --instructions "Terminal style"
# -> harness/out/homepage.tsx
```

The renderer's strict sandbox CSP is applied to production builds only, because dev mode serves scripts from the WXT dev server.
