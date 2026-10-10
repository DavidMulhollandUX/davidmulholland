import Anthropic from "@anthropic-ai/sdk";
import { BuildError, cancelBuild, ensureInfra, runBuild, type BuildCheckpoint } from "@ai-newtab/agent-core";
import { getRankedHistory } from "./history";
import { capturePages } from "./scraper";
import { IDLE_BUILD, load, save, type BuildState, type Settings } from "./storage";

export const ALARM_NAME = "auto-rebuild";
const MAX_STEPS = 80;

let active: { controller: AbortController; done: Promise<void> } | null = null;
let state: BuildState = IDLE_BUILD;

function makeClient(apiKey: string): Anthropic {
  // The extension is the user's own client and the key is theirs; there is no server to proxy through.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 });
}

async function setState(patch: Partial<BuildState>): Promise<void> {
  state = { ...state, ...patch };
  await save("buildState", state);
}

async function addStep(text: string): Promise<void> {
  const steps = [...state.steps, { at: new Date().toISOString(), text }].slice(-MAX_STEPS);
  await setState({ steps });
}

export function isBuilding(): boolean {
  return active !== null;
}

/** Called once when the service worker starts: a "running" build with no live worker was interrupted. */
export async function recoverAfterRestart(): Promise<void> {
  state = await load("buildState");
  if (state.status === "running" && !active) {
    await setState({
      status: state.checkpoint ? "interrupted" : "error",
      error: state.checkpoint ? "The build was interrupted (the browser closed or the extension restarted)." : "The build was interrupted before it started.",
      finishedAt: new Date().toISOString(),
    });
  }
}

export async function startBuild(trigger: "manual" | "scheduled" | "resume"): Promise<void> {
  if (active) return;
  state = await load("buildState");
  const settings = await load("settings");
  if (!settings.apiKey) {
    await setState({ ...IDLE_BUILD, status: "error", error: "Add your Anthropic API key in Settings first." });
    return;
  }

  const resume: BuildCheckpoint | null = trigger === "resume" || state.status === "interrupted" ? state.checkpoint : null;
  if (trigger === "resume" && !resume) {
    await setState({ status: "error", error: "There is no interrupted build to resume." });
    return;
  }

  const controller = new AbortController();
  const done = run(trigger, resume, settings, controller.signal).finally(() => {
    active = null;
  });
  active = { controller, done };
}

async function run(
  trigger: "manual" | "scheduled" | "resume",
  resume: BuildCheckpoint | null,
  settings: Settings,
  signal: AbortSignal,
): Promise<void> {
  const model = resume && state.model ? state.model : settings.model;
  await setState({
    status: "running",
    trigger,
    model,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    steps: resume ? state.steps : [],
    checkpoint: resume,
  });

  // A service worker is stopped after ~30s without extension API activity,
  // and a long-lived fetch stream alone does not count. Ping an API to stay up.
  const keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  const client = makeClient(settings.apiKey);
  try {
    if (!resume) await addStep("Preparing the agent");
    const infra = await ensureInfra(client, await load("infra"));
    await save("infra", infra);

    const result = await runBuild({
      client,
      infra,
      model,
      instructions: settings.instructions,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      resume,
      signal,
      host: { getHistory: getRankedHistory, getPageHtml: capturePages },
      callbacks: {
        onProgress: (text) => void addStep(text),
        onCheckpoint: (checkpoint) => setState({ checkpoint: { ...checkpoint } }),
      },
    });

    await save("homepage", {
      tsx: result.tsx,
      builtAt: new Date().toISOString(),
      model,
      pageCount: result.pageCount,
      summary: result.summary,
    });
    await setState({ status: "done", finishedAt: new Date().toISOString(), checkpoint: null });
    await scheduleAutoRebuild();
  } catch (err) {
    if (signal.aborted) return; // cancelBuild() owns the state from here.
    const buildErr = err instanceof BuildError ? err : new BuildError(err instanceof Error ? err.message : String(err), false);
    const canResume = buildErr.resumable && state.checkpoint !== null;
    await setState({
      status: canResume ? "interrupted" : "error",
      error: buildErr.message,
      finishedAt: new Date().toISOString(),
      checkpoint: canResume ? state.checkpoint : null,
    });
  } finally {
    clearInterval(keepAlive);
  }
}

/** Stop the running build, or discard an interrupted one, deleting its session. */
export async function stopBuild(): Promise<void> {
  state = await load("buildState");
  const checkpoint = state.checkpoint;
  if (active) {
    active.controller.abort();
    await active.done.catch(() => {});
  }
  await setState({ status: "idle", error: null, checkpoint: null, finishedAt: new Date().toISOString() });
  await addStep("Build cancelled");
  const { apiKey } = await load("settings");
  if (checkpoint && apiKey) await cancelBuild(makeClient(apiKey), checkpoint).catch(() => {});
}

/** Auto-rebuild only starts once a homepage exists (i.e. after the first build). */
export async function scheduleAutoRebuild(): Promise<void> {
  const [{ autoRebuildHours }, homepage] = await Promise.all([load("settings"), load("homepage")]);
  await chrome.alarms.clear(ALARM_NAME);
  if (!autoRebuildHours || !homepage) return;
  const builtAt = Date.parse(homepage.builtAt);
  const periodMs = autoRebuildHours * 60 * 60 * 1000;
  chrome.alarms.create(ALARM_NAME, {
    when: Math.max(Date.now() + 60_000, builtAt + periodMs),
    periodInMinutes: autoRebuildHours * 60,
  });
}
