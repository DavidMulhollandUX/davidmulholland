/**
 * Offline test of the build orchestrator against a scripted fake of the
 * Managed Agents API. Exercises the full tool round-trip, the page cap,
 * a dropped stream, resuming after the host died, and cleanup.
 *
 *   pnpm --filter @ai-newtab/harness test
 */
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { MAX_PAGES, runBuild, type BuildCheckpoint, type ToolHost } from "@ai-newtab/agent-core";
import { cleanHtml } from "./nodeHost.js";

type Ev = Record<string, any> & { type: string; id: string };

const OUTPUT_TSX = `export default function Homepage() { return <main>hi</main>; }`;

class FakeApi {
  events: Ev[] = [];
  private listeners = new Set<(e: Ev) => void>();
  private n = 0;
  status: "idle" | "running" = "idle";
  mounts: { file_id: string; mount_path?: string | null }[] = [];
  uploads: string[] = [];
  deletedFiles: string[] = [];
  sessionDeleted = false;
  outputWritten = false;
  toolResults: Record<string, string> = {};
  /** Close the first stream after this many delivered events (simulates a drop). */
  dropFirstStreamAfter = Infinity;
  private streamsOpened = 0;

  emit(partial: Omit<Ev, "id"> & { id?: string }): Ev {
    const event = { id: `sevt_${++this.n}`, processed_at: new Date().toISOString(), ...partial } as unknown as Ev;
    if (event.type === "session.status_running") this.status = "running";
    if (event.type === "session.status_idle") this.status = "idle";
    this.events.push(event);
    for (const l of this.listeners) l(event);
    return event;
  }

  /** The scripted agent: reacts to what the client sends. */
  private react(event: Ev) {
    if (event.type === "user.message") {
      this.emit({ type: "session.status_running" });
      this.emit({ type: "span.model_request_start" });
      const use = this.emit({ type: "agent.custom_tool_use", name: "getHistory", input: { days: 7 } });
      this.emit({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: [use.id] } });
    }
    if (event.type === "user.custom_tool_result") {
      const use = this.events.find((e) => e.id === event.custom_tool_use_id)!;
      const text = event.content[0].text as string;
      this.toolResults[use.name] = text;
      this.emit({ type: "session.status_running" });
      if (use.name === "getHistory") {
        const urls = Array.from({ length: MAX_PAGES + 2 }, (_, i) => `https://site${i}.example/`);
        const next = this.emit({ type: "agent.custom_tool_use", name: "getPageHtml", input: { urls: [...urls, "not a url"] } });
        this.emit({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: [next.id] } });
      } else {
        this.emit({ type: "agent.tool_use", name: "grep", input: { pattern: "<a href" }, evaluated_permission: "allow" });
        this.emit({ type: "agent.tool_use", name: "write", input: { file_path: "/mnt/session/outputs/homepage.tsx" }, evaluated_permission: "allow" });
        this.outputWritten = true;
        this.emit({ type: "agent.message", content: [{ type: "text", text: "Built a two-column page from 7 sources." }] });
        this.emit({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
      }
    }
  }

  client(): Anthropic {
    const api = this;
    const stream = () => {
      const opened = ++api.streamsOpened;
      const queue: Ev[] = [];
      let wake: (() => void) | null = null;
      const controller = new AbortController();
      let delivered = 0;
      const listener = (e: Ev) => {
        queue.push(e);
        wake?.();
      };
      api.listeners.add(listener);
      controller.signal.addEventListener("abort", () => wake?.());
      return {
        controller,
        async *[Symbol.asyncIterator]() {
          try {
            while (!controller.signal.aborted) {
              if (opened === 1 && delivered >= api.dropFirstStreamAfter) return;
              const next = queue.shift();
              if (next) {
                delivered++;
                // Interleave a streaming fragment without an id, like the real API.
                yield { type: "agent.message_delta" };
                yield next;
                continue;
              }
              await new Promise<void>((r) => (wake = r));
              wake = null;
            }
          } finally {
            api.listeners.delete(listener);
          }
        },
      };
    };
    const asyncList = <T,>(items: T[]) => ({
      async *[Symbol.asyncIterator]() {
        yield* items;
      },
    });

    const fake = {
      beta: {
        sessions: {
          create: async () => ({ id: "sesn_test", status: "idle" }),
          retrieve: async () => ({ id: "sesn_test", status: api.status }),
          delete: async () => {
            api.sessionDeleted = true;
          },
          events: {
            stream: async () => stream(),
            list: () => asyncList([...api.events]),
            send: async (_id: string, { events }: { events: Omit<Ev, "id">[] }) => {
              for (const e of events) {
                const sent = api.emit(e);
                queueMicrotask(() => api.react(sent));
              }
              return {};
            },
          },
          resources: {
            add: async (_id: string, params: { file_id: string; mount_path?: string }) => {
              api.mounts.push(params);
              return { id: `res_${api.mounts.length}`, ...params };
            },
          },
        },
        files: {
          list: () =>
            asyncList(api.outputWritten ? [{ id: "file_out", filename: "homepage.tsx", created_at: new Date().toISOString() }] : []),
          download: async () => new Response(OUTPUT_TSX),
        },
      },
      files: {
        upload: async () => {
          const id = `file_up_${api.uploads.length + 1}`;
          api.uploads.push(id);
          return { id };
        },
        delete: async (id: string) => {
          api.deletedFiles.push(id);
        },
      },
    };
    return fake as unknown as Anthropic;
  }
}

const host: ToolHost = {
  async getHistory({ days }) {
    return { generatedAt: new Date().toISOString(), days, totalVisits: 3, domains: [] };
  },
  async getPageHtml(urls) {
    return urls.map((url, i) =>
      i === 2
        ? { ok: false as const, url, error: "HTTP 500" }
        : { ok: true as const, url, finalUrl: url, title: `Page ${i}`, html: `<ul><li><a href="${url}a">A</a></li></ul>` },
    );
  },
};

const infra = { agentId: "agent_test", environmentId: "env_test", configVersion: 1 };

async function testFullBuild() {
  const api = new FakeApi();
  api.dropFirstStreamAfter = 4; // drop mid-build; the driver must reconnect and catch up
  const progress: string[] = [];
  const checkpoints: BuildCheckpoint[] = [];
  const result = await runBuild({
    client: api.client(),
    infra,
    model: "claude-haiku-5-5",
    instructions: "Terminal style",
    host,
    callbacks: { onProgress: (t) => progress.push(t), onCheckpoint: (c) => void checkpoints.push({ ...c }) },
  });

  assert.equal(result.tsx, OUTPUT_TSX);
  assert.equal(result.pageCount, MAX_PAGES - 1, "one page failed to load");
  assert.equal(result.summary, "Built a two-column page from 7 sources.");
  assert.match(api.events.find((e) => e.type === "user.message")!.content[0].text, /Terminal style/);

  const pagesResult = api.toolResults.getPageHtml;
  assert.match(pagesResult, /\/mnt\/session\/uploads\/pages\/01-site0\.example\.html/);
  assert.match(pagesResult, /site2\.example\/ -> failed: HTTP 500/);
  assert.equal((pagesResult.match(/page limit/g) ?? []).length, 2, "URLs past the cap are refused");
  assert.ok(!pagesResult.includes("not a url"), "invalid URLs are dropped");
  assert.equal(api.mounts.length, MAX_PAGES - 1);
  assert.ok(api.mounts.every((m) => m.mount_path?.startsWith("/pages/")));

  const results = api.events.filter((e) => e.type === "user.custom_tool_result");
  assert.equal(results.length, 2, "each tool call answered exactly once despite the dropped stream");
  assert.ok(progress.some((p) => p.includes("reconnecting")), "stream drop was noticed");
  assert.ok(progress.some((p) => p.startsWith("Writing homepage.tsx")));

  assert.ok(api.sessionDeleted, "session deleted");
  for (const id of [...api.uploads, "file_out"]) assert.ok(api.deletedFiles.includes(id), `${id} deleted`);
  assert.equal(checkpoints.at(-1)?.uploadedFileIds.length, MAX_PAGES - 1);
  console.log("ok - full build with dropped stream");
}

async function testResume() {
  // Simulate a service worker that died after the agent asked for history.
  const api = new FakeApi();
  api.emit({ type: "user.message", content: [{ type: "text", text: "Build today's homepage." }] });
  api.emit({ type: "session.status_running" });
  const use = api.emit({ type: "agent.custom_tool_use", name: "getHistory", input: {} });
  api.emit({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: [use.id] } });

  const result = await runBuild({
    client: api.client(),
    infra,
    model: "claude-sonnet-5-5",
    instructions: "",
    host,
    resume: { sessionId: "sesn_test", uploadedFileIds: [], pagesFetched: 0, pageCount: 0 },
    callbacks: { onProgress: () => {}, onCheckpoint: () => {} },
  });
  assert.equal(result.tsx, OUTPUT_TSX);
  assert.equal(api.events.filter((e) => e.type === "user.message").length, 1, "resume does not re-send the kickoff");
  assert.equal(api.events.filter((e) => e.type === "user.custom_tool_result").length, 2);
  console.log("ok - resume answers the pending tool call");
}

function testCleanHtml() {
  const html = cleanHtml(
    `<html><body><script>x()</script><a class="c" href="/p?a=1&amp;b=2" onclick="y">Link</a><img src="i.png" data-x="1"></body></html>`,
    "https://ex.com/dir/",
  );
  assert.equal(html, `<a href="https://ex.com/p?a=1&b=2">Link</a><img src="https://ex.com/dir/i.png">`);
  console.log("ok - harness HTML cleaner");
}

testCleanHtml();
await testFullBuild();
await testResume();
