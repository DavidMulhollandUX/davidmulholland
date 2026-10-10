# Architecture

Three parties, no server of your own:

- **The extension**: an MV3 service worker that drives builds, and the new-tab page that shows them.
- **Anthropic orchestration**: runs the agent loop for a Managed Agents session and emits events.
- **The session sandbox**: a container where the agent's file tools run against mounted files.

The agent loop is driven from the service worker, not the new-tab page, so a build survives closing the tab and can run on a schedule.

## One-time setup

On the first build, `ensureInfra()` (`packages/agent-core/src/setup.ts`) creates, under the user's key:

- an **environment**: `cloud`, `limited` networking with no allowed hosts (the agent never needs the network);
- an **agent**: the system prompt, the file tools (`read`, `write`, `edit`, `glob`, `grep`; no `bash`, no web tools), and two custom tools, `getHistory` and `getPageHtml`.

Their IDs are stored in `chrome.storage.local` (`infra`). Bumping `AGENT_CONFIG_VERSION` makes the next build update the agent in place (a new agent version) instead of creating another. The model is chosen per build with an `agent_with_overrides` session, so switching models never touches the agent.

## A build

```
service worker                     Anthropic                         sandbox
--------------                     ---------                         -------
sessions.create (model override) ->
open event stream                ->
send kickoff user.message        ->  agent plans
                                 <-  agent.custom_tool_use getHistory
chrome.history.search, rank
user.custom_tool_result (JSON)   ->
                                 <-  agent.custom_tool_use getPageHtml [<=8 urls]
open minimized window, load tabs,
inject extractPage(), close
files.upload each page
sessions.resources.add           ->                                   /mnt/session/uploads/pages/NN-host.html
user.custom_tool_result (paths)  ->
                                     agent.tool_use glob/grep/read -> reads pages
                                     agent.tool_use write          -> /mnt/session/outputs/homepage.tsx
                                 <-  agent.message (summary)
                                 <-  session.status_idle end_turn
files.list(scope_id=session)     ->
files.download homepage.tsx      ->
sessions.delete, files.delete (pages + output)
save homepage, schedule alarm
```

Details worth knowing (`packages/agent-core/src/orchestrator.ts`):

- **Stream first.** The event stream is opened before the kickoff is sent, so no early events are missed.
- **Idle is not done.** The driver only stops on `session.status_idle` with `end_turn`. `requires_action` means a custom tool call is waiting; `retries_exhausted`, `refusal` and `budget_reached` end the build with an error; `session.status_terminated` is an error.
- **Reconnect without losing events.** SSE has no replay. If the stream drops, the driver reopens it, then walks `events.list` and answers any `agent.custom_tool_use` that has no matching `user.custom_tool_result`. Every event ID is tracked so nothing is handled twice.
- **The 8-page cap is per build**, enforced by the orchestrator, not just the prompt. Extra URLs come back as "skipped".
- **Missing output.** If the agent ends its turn without writing `homepage.tsx`, it gets one follow-up message asking it to finish.
- **Cleanup** waits for the session to leave `running` (the queryable status lags the stream), deletes it, then deletes every uploaded page and the captured output file.

## Resuming

The service worker can be stopped by Chrome mid-build (the browser closes, or the worker idles out). Two things limit the damage:

- **Keep-alive.** During a build the worker calls `chrome.runtime.getPlatformInfo()` every 20 seconds; extension API calls reset the idle timer, and an open fetch stream on its own does not.
- **Checkpoints.** The session ID, uploaded file IDs and page counts are written to storage as the build progresses (`buildState.checkpoint`). When the worker restarts and finds a build marked `running`, it marks it `interrupted`. The new-tab page then offers **Resume** (or **Discard**, which interrupts and deletes the session). A scheduled rebuild also resumes an interrupted build rather than starting over.

Resume uses the same reconcile path as a stream reconnect: replay history, answer pending tool calls, keep streaming.

## The two custom tools

They run in the extension because they need `chrome.history`, `chrome.tabs` and `chrome.scripting`.

**getHistory** (`lib/history.ts`, `agent-core/src/history.ts`): `chrome.history.search` over N days (default 7), blocked URLs removed, grouped by domain, ranked by visits weighted by recency (3-day decay) with typed visits counting double. Returns the top domains with up to six sample pages each.

**getPageHtml** (`lib/scraper.ts`): opens a minimized, unfocused window, loads up to four tabs at a time (muted), waits for `complete` (25s cap) plus a short settle, refuses pages that redirected to a blocked URL (login walls), then injects `extractPage()`. That function scrolls to trigger lazy loading, clones `<body>`, drops scripts, styles, SVG, media, forms and hidden nodes, keeps only `href`, `src`, `alt`, `title`, `datetime` and `aria-label`, makes links and lazy image sources absolute, collapses empty wrappers, and truncates at 400k characters. Each page is uploaded with a header comment carrying its URL.

## Rendering

The new-tab page never evaluates model code. It posts the TSX to `renderer.html`, a page listed under the manifest's `sandbox` key and loaded in an iframe with `sandbox="allow-scripts allow-popups"`. There:

- Sucrase compiles TypeScript + JSX (automatic runtime) to CommonJS.
- A tiny `require` exposes only `react` and `react/jsx-runtime`.
- The component renders inside an error boundary; compile and render errors are posted back and shown as a toast with a Rebuild button.
- Link clicks are intercepted and posted to the parent, which navigates the tab (or opens a background tab for modifier/middle clicks). Only http(s) URLs are followed.

The sandbox CSP (`wxt.config.ts`) is `default-src 'none'` with `connect-src 'none'`, so generated code cannot fetch, open sockets or post forms. It also has no `chrome.*` APIs and an opaque origin, so it cannot read storage, history or the key.

The original project renders with Sandpack. This implementation uses an in-extension compiler instead so rendering works offline and model code never reaches a third-party bundler.

## The harness

`harness/run.ts` runs a real build from Node using the same `runBuild()`, with history from `fixtures/history.json` and pages fetched logged-out (`harness/nodeHost.ts`). `harness/mock.test.ts` runs the orchestrator against a scripted fake of the Managed Agents API to check the tool round-trip, the page cap, a dropped stream, resume after a crash, and cleanup, without spending anything.
