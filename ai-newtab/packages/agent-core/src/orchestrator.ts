import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { buildKickoffMessage, OUTPUT_PATH, PAGES_DIR } from "./prompt.js";
import { clampInt, MAX_PAGES } from "./tools.js";
import type {
  BuildCallbacks,
  BuildCheckpoint,
  BuildResult,
  InfraIds,
  ModelId,
  PageCapture,
  ToolHost,
} from "./types.js";

type SessionEvent = Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent;
type StreamEvent = Anthropic.Beta.Sessions.BetaManagedAgentsStreamSessionEvents;
type CustomToolUse = Anthropic.Beta.Sessions.BetaManagedAgentsAgentCustomToolUseEvent;

const SESSIONS_BETA = "managed-agents-2026-04-01";
const OUTPUT_FILENAME = OUTPUT_PATH.split("/").pop()!;
const MAX_STREAM_RECONNECTS = 3;

export class BuildError extends Error {
  constructor(
    message: string,
    /** True when the session is still alive and the build can be resumed later. */
    readonly resumable: boolean,
  ) {
    super(message);
    this.name = "BuildError";
  }
}

export interface RunBuildOptions {
  client: Anthropic;
  infra: InfraIds;
  model: ModelId;
  instructions: string;
  host: ToolHost;
  callbacks: BuildCallbacks;
  /** Pass a saved checkpoint to resume an interrupted build. */
  resume?: BuildCheckpoint | null;
  timeZone?: string;
  now?: Date;
  signal?: AbortSignal;
}

/**
 * Run one homepage build as a Managed Agents session: kick off the agent,
 * answer its custom tool calls from the host, then download the TSX it wrote.
 * The session and every uploaded file are deleted once the build ends,
 * unless it ends in a resumable state.
 */
export async function runBuild(opts: RunBuildOptions): Promise<BuildResult> {
  const { client, callbacks, signal } = opts;
  const resuming = Boolean(opts.resume);
  let checkpoint: BuildCheckpoint;

  if (opts.resume) {
    checkpoint = { ...opts.resume };
    callbacks.onProgress("Resuming the interrupted build");
  } else {
    callbacks.onProgress("Starting a build session");
    const session = await client.beta.sessions.create(
      {
        agent: { type: "agent_with_overrides", id: opts.infra.agentId, model: opts.model },
        environment_id: opts.infra.environmentId,
        title: `Homepage ${new Date().toISOString().slice(0, 10)}`,
      },
      { signal },
    );
    checkpoint = { sessionId: session.id, uploadedFileIds: [], pagesFetched: 0, pageCount: 0 };
    await callbacks.onCheckpoint(checkpoint);
  }

  const driver = new SessionDriver(opts, checkpoint);
  let outputFileId: string | null = null;
  try {
    const kickoff = resuming
      ? null
      : buildKickoffMessage({ instructions: opts.instructions, now: opts.now ?? new Date(), timeZone: opts.timeZone });
    await driver.drive(kickoff);

    let output = await findOutput(client, checkpoint.sessionId, signal);
    if (!output) {
      callbacks.onProgress("The agent stopped before writing the page; asking it to finish");
      await driver.drive(`You have not written ${OUTPUT_PATH} yet. Write the complete component there now.`);
      output = await findOutput(client, checkpoint.sessionId, signal);
    }
    if (!output) throw new BuildError(`The agent finished without writing ${OUTPUT_FILENAME}.`, false);
    outputFileId = output.id;

    callbacks.onProgress("Downloading the finished page");
    const res = await client.beta.files.download(output.id, { betas: [SESSIONS_BETA] }, { signal });
    const tsx = await res.text();
    if (!tsx.trim()) throw new BuildError(`${OUTPUT_FILENAME} was empty.`, false);

    await cleanupBuild(client, checkpoint, [outputFileId]);
    callbacks.onProgress("Done. Session and uploaded pages deleted");
    return { tsx, sessionId: checkpoint.sessionId, pageCount: checkpoint.pageCount, summary: driver.summary };
  } catch (err) {
    const buildErr = toBuildError(err, signal);
    if (!buildErr.resumable) {
      await cleanupBuild(client, checkpoint, outputFileId ? [outputFileId] : []).catch(() => {});
    }
    throw buildErr;
  }
}

/** Stop a build in progress (or abandon an interrupted one) and delete its session and files. */
export async function cancelBuild(client: Anthropic, checkpoint: BuildCheckpoint): Promise<void> {
  try {
    await client.beta.sessions.events.send(checkpoint.sessionId, { events: [{ type: "user.interrupt" }] });
  } catch {
    // Already idle, terminated or deleted.
  }
  await cleanupBuild(client, checkpoint, []);
}

class SessionDriver {
  summary = "";
  private readonly seen = new Set<string>();
  private readonly answered = new Set<string>();
  private thinkingAnnounced = false;

  constructor(
    private readonly opts: RunBuildOptions,
    private readonly checkpoint: BuildCheckpoint,
  ) {}

  private get client() {
    return this.opts.client;
  }
  private get sessionId() {
    return this.checkpoint.sessionId;
  }
  private progress(text: string) {
    this.opts.callbacks.onProgress(text);
  }

  /**
   * Send `message` (if any) and process events until the agent's turn ends.
   * Reconnects with history replay if the stream drops.
   */
  async drive(message: string | null): Promise<void> {
    const { signal } = this.opts;
    let pendingMessage = message;
    for (let attempt = 0; attempt <= MAX_STREAM_RECONNECTS; attempt++) {
      // Stream first so nothing emitted after the send is missed.
      const stream = await this.client.beta.sessions.events.stream(this.sessionId, undefined, { signal });
      try {
        if (pendingMessage) {
          await this.client.beta.sessions.events.send(
            this.sessionId,
            { events: [{ type: "user.message", content: [{ type: "text", text: pendingMessage }] }] },
            { signal },
          );
          pendingMessage = null;
        } else {
          // Resume or reconnect: replay history so missed tool calls get answered.
          const outcome = await this.reconcile();
          if (outcome === "done") return;
        }

        for await (const event of stream) {
          // Start/delta events are streaming fragments without ids; the full events follow.
          if (!("id" in event)) continue;
          if (!this.seen.has(event.id)) {
            this.seen.add(event.id);
            await this.handle(event);
          }
          if (event.type === "session.status_terminated") {
            throw new BuildError("The build session was terminated.", false);
          }
          if (event.type === "session.status_idle") {
            const reason = event.stop_reason;
            if (reason.type === "requires_action") {
              if (reason.event_ids.some((id) => !this.answered.has(id))) await this.reconcile();
              continue;
            }
            if (reason.type === "end_turn") return;
            throw new BuildError(describeStop(reason.type), false);
          }
        }
      } finally {
        stream.controller.abort();
      }
      if (signal?.aborted) throw new BuildError("Build cancelled.", true);
      this.progress("Connection to the session dropped; reconnecting");
    }
    throw new BuildError("Lost the connection to the build session.", true);
  }

  /**
   * Walk the session's event history, answer any custom tool calls still waiting
   * on us, and report whether the agent's turn has already ended.
   */
  private async reconcile(): Promise<"done" | "running"> {
    const pending = new Map<string, CustomToolUse>();
    let ended = false;
    for await (const event of this.client.beta.sessions.events.list(this.sessionId, {}, { signal: this.opts.signal })) {
      const fresh = !this.seen.has(event.id);
      this.seen.add(event.id);
      if (fresh && event.type !== "agent.custom_tool_use") await this.handle(event);
      switch (event.type) {
        case "agent.custom_tool_use":
          if (!this.answered.has(event.id)) pending.set(event.id, event);
          break;
        case "user.custom_tool_result":
          this.answered.add(event.custom_tool_use_id);
          pending.delete(event.custom_tool_use_id);
          break;
        case "session.status_running":
          ended = false;
          break;
        case "session.status_idle":
          ended = event.stop_reason.type === "end_turn";
          if (event.stop_reason.type !== "requires_action" && event.stop_reason.type !== "end_turn") {
            throw new BuildError(describeStop(event.stop_reason.type), false);
          }
          break;
        case "session.status_terminated":
          throw new BuildError("The build session was terminated.", false);
      }
    }
    for (const event of pending.values()) await this.answerToolUse(event);
    return ended && pending.size === 0 ? "done" : "running";
  }

  private async handle(event: SessionEvent | StreamEvent): Promise<void> {
    switch (event.type) {
      case "span.model_request_start":
        if (!this.thinkingAnnounced) {
          this.thinkingAnnounced = true;
          this.progress("Agent is planning");
        }
        break;
      case "agent.message": {
        const text = event.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("")
          .trim();
        if (text) {
          this.summary = text;
          this.progress(`Agent: ${truncate(text, 220)}`);
        }
        break;
      }
      case "agent.tool_use": {
        const line = describeToolUse(event.name, event.input);
        if (line) this.progress(line);
        if (event.evaluated_permission === "ask") {
          // Nobody is watching a background build, so anything that needs approval is denied.
          await this.client.beta.sessions.events.send(this.sessionId, {
            events: [{ type: "user.tool_confirmation", tool_use_id: event.id, result: "deny" }],
          });
          this.answered.add(event.id);
        }
        break;
      }
      case "agent.custom_tool_use":
        if (!this.answered.has(event.id)) await this.answerToolUse(event);
        break;
      case "session.error":
        this.progress(`Session error: ${truncate(JSON.stringify(event.error ?? event), 200)}`);
        break;
    }
  }

  private async answerToolUse(event: CustomToolUse): Promise<void> {
    if (this.answered.has(event.id)) return;
    this.answered.add(event.id);
    let text: string;
    let isError = false;
    try {
      text = await this.runTool(event.name, event.input as Record<string, unknown>);
    } catch (err) {
      text = `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
      isError = true;
    }
    await this.client.beta.sessions.events.send(
      this.sessionId,
      {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            content: [{ type: "text", text }],
            is_error: isError,
          },
        ],
      },
      { signal: this.opts.signal },
    );
  }

  private async runTool(name: string, input: Record<string, unknown>): Promise<string> {
    if (name === "getHistory") {
      this.progress("Reading your browsing history");
      const summary = await this.opts.host.getHistory({
        days: clampInt(input.days, 1, 30, 7),
        limit: clampInt(input.limit, 5, 60, 40),
      });
      this.progress(`Ranked ${summary.domains.length} sites from ${summary.totalVisits} visits`);
      return JSON.stringify(summary);
    }
    if (name === "getPageHtml") return this.getPages(input.urls);
    throw new Error(`Unknown tool "${name}".`);
  }

  private async getPages(rawUrls: unknown): Promise<string> {
    const urls = [...new Set((Array.isArray(rawUrls) ? rawUrls : []).filter(isHttpUrl))];
    if (urls.length === 0) throw new Error("Pass at least one absolute http(s) URL in `urls`.");

    const remaining = Math.max(0, MAX_PAGES - this.checkpoint.pagesFetched);
    const accepted = urls.slice(0, remaining);
    const lines = urls.slice(remaining).map((url) => `${url} -> skipped: the ${MAX_PAGES}-page limit for this build is used up`);
    if (accepted.length === 0) return lines.join("\n");

    this.progress(`Loading ${accepted.length} page${accepted.length === 1 ? "" : "s"} in a background window`);
    const captures = await this.opts.host.getPageHtml(accepted);
    this.checkpoint.pagesFetched += accepted.length;

    const mounted: string[] = [];
    for (const [i, capture] of captures.entries()) {
      mounted.push(await this.mountCapture(capture, this.checkpoint.pagesFetched - accepted.length + i + 1));
    }
    await this.opts.callbacks.onCheckpoint(this.checkpoint);
    const ok = mounted.filter((line) => !line.includes(" -> failed:")).length;
    this.progress(`Uploaded ${ok} of ${accepted.length} pages to the agent's sandbox`);
    return [...mounted, ...lines].join("\n");
  }

  private async mountCapture(capture: PageCapture, index: number): Promise<string> {
    if (!capture.ok) return `${capture.url} -> failed: ${capture.error}`;
    const host = safeHost(capture.finalUrl);
    const filename = `${String(index).padStart(2, "0")}-${host.replace(/[^a-z0-9.-]/gi, "_")}.html`;
    const header = `<!-- url: ${capture.finalUrl}\n     title: ${capture.title.replace(/--/g, "-")} -->\n`;
    const bytes = new TextEncoder().encode(header + capture.html);
    try {
      const file = await this.client.files.upload(
        { file: await toFile(bytes, filename, { type: "text/html" }) },
        { signal: this.opts.signal },
      );
      this.checkpoint.uploadedFileIds.push(file.id);
      await this.opts.callbacks.onCheckpoint(this.checkpoint);
      await this.client.beta.sessions.resources.add(
        this.sessionId,
        { type: "file", file_id: file.id, mount_path: `/pages/${filename}` },
        { signal: this.opts.signal },
      );
      this.checkpoint.pageCount += 1;
      return `${capture.url} -> ${PAGES_DIR}/${filename} ("${truncate(capture.title, 80)}", ${Math.round(bytes.length / 1024)} KB)`;
    } catch (err) {
      return `${capture.url} -> failed: could not upload (${err instanceof Error ? err.message : String(err)})`;
    }
  }
}

async function findOutput(client: Anthropic, sessionId: string, signal?: AbortSignal) {
  // Outputs are indexed a moment after the session goes idle.
  for (let attempt = 0; attempt < 6; attempt++) {
    let newest: Anthropic.Beta.Files.BetaFileMetadata | null = null;
    for await (const file of client.beta.files.list({ scope_id: sessionId, betas: [SESSIONS_BETA] }, { signal })) {
      if (file.filename.endsWith(OUTPUT_FILENAME) && (!newest || file.created_at > newest.created_at)) newest = file;
    }
    if (newest) return newest;
    await sleep(1000 * (attempt + 1), signal);
  }
  return null;
}

/** Delete the session, the pages we uploaded, and any captured outputs. Best effort. */
async function cleanupBuild(client: Anthropic, checkpoint: BuildCheckpoint, extraFileIds: string[]): Promise<void> {
  // The queryable status lags the stream's idle event slightly.
  for (let i = 0; i < 15; i++) {
    try {
      const session = await client.beta.sessions.retrieve(checkpoint.sessionId);
      if (session.status !== "running") break;
    } catch {
      break;
    }
    await sleep(400);
  }
  try {
    await client.beta.sessions.delete(checkpoint.sessionId);
  } catch {
    // Already gone, or still running; it will be garbage-collected.
  }
  const outputIds: string[] = [];
  try {
    for await (const file of client.beta.files.list({ scope_id: checkpoint.sessionId, betas: [SESSIONS_BETA] })) {
      outputIds.push(file.id);
    }
  } catch {
    // Listing outputs is best effort.
  }
  const ids = [...new Set([...checkpoint.uploadedFileIds, ...extraFileIds, ...outputIds])];
  await Promise.allSettled(ids.map((id) => client.files.delete(id)));
}

function toBuildError(err: unknown, signal?: AbortSignal): BuildError {
  if (err instanceof BuildError) return err;
  if (signal?.aborted) return new BuildError("Build cancelled.", true);
  if (err instanceof Anthropic.AuthenticationError) return new BuildError("The API key was rejected. Check it in Settings.", false);
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new BuildError("This API key does not have access to Managed Agents.", false);
  }
  if (err instanceof Anthropic.NotFoundError) return new BuildError("The build session no longer exists.", false);
  if (err instanceof Anthropic.RateLimitError) return new BuildError("Rate limited by the API. Resume in a minute.", true);
  if (err instanceof Anthropic.APIConnectionError) return new BuildError("Network error talking to the API.", true);
  if (err instanceof Anthropic.APIError) {
    const retryable = (err.status ?? 0) >= 500;
    return new BuildError(`API error ${err.status ?? ""}: ${err.message}`, retryable);
  }
  return new BuildError(err instanceof Error ? err.message : String(err), true);
}

function describeStop(type: string): string {
  switch (type) {
    case "retries_exhausted":
      return "The agent hit repeated errors and gave up.";
    case "refusal":
      return "The model declined to continue this build.";
    case "budget_reached":
      return "The session hit its spending budget.";
    default:
      return `The session stopped unexpectedly (${type}).`;
  }
}

function describeToolUse(name: string, input: unknown): string | null {
  const args = (input ?? {}) as Record<string, unknown>;
  const path = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
  const short = path.split("/").pop() || path;
  switch (name) {
    case "read":
      return short ? `Reading ${short}` : "Reading a page";
    case "grep":
      return typeof args.pattern === "string" ? `Searching pages for /${truncate(args.pattern, 60)}/` : "Searching pages";
    case "glob":
      return "Listing captured pages";
    case "write":
      return `Writing ${short || OUTPUT_FILENAME}`;
    case "edit":
      return `Editing ${short || OUTPUT_FILENAME}`;
    default:
      return null;
  }
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "page";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new BuildError("Build cancelled.", true));
      },
      { once: true },
    );
  });
}
