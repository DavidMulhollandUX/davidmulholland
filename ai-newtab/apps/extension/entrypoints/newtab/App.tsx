import { useCallback, useEffect, useState } from "react";
import { MODELS, type ModelId } from "@ai-newtab/agent-core";
import { send } from "@/lib/protocol";
import { save, type BuildState, type Homepage, type Settings } from "@/lib/storage";
import { HomepageFrame } from "./HomepageFrame";
import { useStore } from "./useStore";

const PRESETS = [
  "A morning newspaper. Serif type, big masthead, lead story, column of briefs.",
  "One calm column. No images. Five things worth reading, one line on why each matters.",
  "Dense dashboard: GitHub PRs first, then Hacker News, then everything else in compact cards.",
  "Green-on-black terminal, monospace, every item numbered like a command listing.",
  "Skip sports and politics. Always show weather and my next three calendar events if you can find them.",
];

const INTERVALS: { value: Settings["autoRebuildHours"]; label: string }[] = [
  { value: 0, label: "Off" },
  { value: 6, label: "Every 6 hours" },
  { value: 12, label: "Every 12 hours" },
  { value: 24, label: "Every day" },
  { value: 48, label: "Every 2 days" },
];

export function App() {
  const settings = useStore("settings");
  const homepage = useStore("homepage");
  const build = useStore("buildState");
  const [panel, setPanel] = useState<"none" | "settings" | "progress">("none");
  const [renderError, setRenderError] = useState<string | null>(null);

  // Open the progress panel when a build starts from this tab.
  useEffect(() => {
    if (build?.status === "running" && !homepage) setPanel("progress");
  }, [build?.status, homepage]);

  const onRenderError = useCallback((message: string | null) => setRenderError(message), []);

  if (!settings || build === undefined || homepage === undefined) return <div className="shell" />;

  if (!settings.apiKey) return <Onboarding settings={settings} />;

  const running = build.status === "running";

  return (
    <div className="shell">
      {homepage ? (
        <HomepageFrame tsx={homepage.tsx} onError={onRenderError} />
      ) : (
        <EmptyState build={build} onBuild={() => void send({ type: "build" }).then(() => setPanel("progress"))} />
      )}

      {renderError && (
        <div className="toast error" role="alert">
          <strong>This homepage failed to render.</strong> {renderError}
          <button className="link" onClick={() => void send({ type: "build" }).then(() => setPanel("progress"))}>
            Rebuild
          </button>
        </div>
      )}

      <ControlBar
        homepage={homepage}
        build={build}
        onBuild={() => void send({ type: "build" }).then(() => setPanel("progress"))}
        onProgress={() => setPanel(panel === "progress" ? "none" : "progress")}
        onSettings={() => setPanel(panel === "settings" ? "none" : "settings")}
      />

      {panel === "progress" && <ProgressPanel build={build} onClose={() => setPanel("none")} />}
      {panel === "settings" && <SettingsPanel settings={settings} onClose={() => setPanel("none")} />}
    </div>
  );
}

function Onboarding({ settings }: { settings: Settings }) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const valid = key.trim().startsWith("sk-ant-");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return;
    setSaving(true);
    await save("settings", { ...settings, apiKey: key.trim() });
    await send({ type: "build" });
  }

  return (
    <div className="onboarding">
      <form className="card" onSubmit={submit}>
        <p className="eyebrow">AI New Tab</p>
        <h1>The Morning Tab</h1>
        <p className="lede">
          Claude reads the sites you visit most, opens up to eight of them in a background window while you&rsquo;re
          signed in, and writes you a homepage from what&rsquo;s on them today.
        </p>
        <label className="field">
          <span>Anthropic API key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <button className="primary" type="submit" disabled={!valid || saving}>
          {saving ? "Starting…" : "Build today’s homepage"}
        </button>
        <ul className="fineprint">
          <li>Each build sends a summary of your recent history and the cleaned HTML of up to 8 pages to Anthropic under your key, then deletes the session and uploads.</li>
          <li>Search, webmail, banking and login pages are skipped.</li>
          <li>The key is stored in this browser profile&rsquo;s extension storage. Anyone with access to the profile can read it.</li>
          <li>A build is one Managed Agents session; expect well under a dollar on Sonnet.</li>
        </ul>
      </form>
    </div>
  );
}

function EmptyState({ build, onBuild }: { build: BuildState; onBuild: () => void }) {
  const running = build.status === "running";
  return (
    <div className="onboarding">
      <div className="card">
        <p className="eyebrow">AI New Tab</p>
        <h1>{running ? "Building your homepage…" : "No homepage yet"}</h1>
        <p className="lede">
          {running
            ? "This usually takes two to four minutes. You can close this tab; the build keeps going."
            : "Build one now. You can describe the layout and what to include in Settings first."}
        </p>
        {!running && (
          <button className="primary" onClick={onBuild}>
            Build today&rsquo;s homepage
          </button>
        )}
        {build.status === "error" && build.error && <p className="error-text">{build.error}</p>}
      </div>
    </div>
  );
}

function ControlBar(props: {
  homepage: Homepage | null;
  build: BuildState;
  onBuild: () => void;
  onProgress: () => void;
  onSettings: () => void;
}) {
  const { homepage, build } = props;
  const running = build.status === "running";
  const lastStep = build.steps.at(-1)?.text;
  let status: string;
  if (running) status = lastStep ?? "Building…";
  else if (build.status === "interrupted") status = "Build interrupted";
  else if (build.status === "error") status = "Last build failed";
  else if (homepage) status = `Built ${formatWhen(homepage.builtAt)}`;
  else status = "Not built yet";

  return (
    <div className={`control-bar ${running ? "is-running" : ""}`}>
      <button className="status" onClick={props.onProgress} title="Show build log">
        <span className={`dot ${build.status}`} aria-hidden />
        <span className="status-text">{status}</span>
      </button>
      {build.status === "interrupted" ? (
        <button className="pill" onClick={() => void send({ type: "resume" })}>
          Resume
        </button>
      ) : (
        <button className="pill" onClick={props.onBuild} disabled={running}>
          Rebuild
        </button>
      )}
      <button className="icon" onClick={props.onSettings} aria-label="Settings" title="Settings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  );
}

function ProgressPanel({ build, onClose }: { build: BuildState; onClose: () => void }) {
  const running = build.status === "running";
  return (
    <aside className="panel" aria-label="Build progress">
      <header>
        <h2>{running ? "Building" : build.status === "interrupted" ? "Interrupted" : "Last build"}</h2>
        <button className="icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {build.startedAt && (
        <p className="meta">
          Started {formatWhen(build.startedAt)}
          {build.model ? ` · ${modelLabel(build.model)}` : ""}
          {build.trigger === "scheduled" ? " · scheduled" : ""}
        </p>
      )}
      <ol className="steps">
        {build.steps.map((step, i) => (
          <li key={`${step.at}-${i}`} className={i === build.steps.length - 1 && running ? "current" : ""}>
            <time>{new Date(step.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time>
            <span>{step.text}</span>
          </li>
        ))}
        {build.steps.length === 0 && <li className="muted">Nothing yet.</li>}
      </ol>
      {build.error && <p className="error-text">{build.error}</p>}
      <footer>
        {running && (
          <button className="secondary" onClick={() => void send({ type: "cancel" })}>
            Cancel build
          </button>
        )}
        {build.status === "interrupted" && (
          <>
            <button className="primary" onClick={() => void send({ type: "resume" })}>
              Resume
            </button>
            <button className="secondary" onClick={() => void send({ type: "cancel" })}>
              Discard
            </button>
          </>
        )}
        {!running && build.status !== "interrupted" && (
          <button className="primary" onClick={() => void send({ type: "build" })}>
            Build now
          </button>
        )}
      </footer>
    </aside>
  );
}

function SettingsPanel({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const [draft, setDraft] = useState(settings);
  const [keyDraft, setKeyDraft] = useState("");
  const [saved, setSaved] = useState(false);

  async function persist(next: Settings) {
    await save("settings", next);
    await send({ type: "settings-updated" });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    const apiKey = keyDraft.trim() ? keyDraft.trim() : draft.apiKey;
    const next = { ...draft, apiKey };
    setDraft(next);
    setKeyDraft("");
    await persist(next);
  }

  async function forgetKey() {
    if (!confirm("Remove the API key from this browser? Builds will stop until you add one again.")) return;
    await persist({ ...draft, apiKey: "" });
  }

  return (
    <aside className="panel" aria-label="Settings">
      <header>
        <h2>Settings</h2>
        <button className="icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <form onSubmit={onSave} className="settings">
        <label className="field">
          <span>Instructions</span>
          <textarea
            rows={7}
            placeholder="Describe the layout, the style, what to include and what to skip."
            value={draft.instructions}
            onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
          />
        </label>
        <div className="presets" aria-label="Examples">
          {PRESETS.map((preset) => (
            <button
              type="button"
              key={preset}
              className="chip"
              onClick={() => setDraft({ ...draft, instructions: draft.instructions ? `${draft.instructions}\n${preset}` : preset })}
            >
              {preset.split(".")[0]}
            </button>
          ))}
        </div>

        <label className="field">
          <span>Model</span>
          <select value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value as ModelId })}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Rebuild automatically</span>
          <select
            value={draft.autoRebuildHours}
            onChange={(e) => setDraft({ ...draft, autoRebuildHours: Number(e.target.value) as Settings["autoRebuildHours"] })}
          >
            {INTERVALS.map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </select>
          <small>Starts after your first build. Each rebuild is a new paid session.</small>
        </label>

        <label className="field">
          <span>API key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={draft.apiKey ? `Saved (…${draft.apiKey.slice(-4)}). Paste to replace.` : "sk-ant-…"}
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
          />
        </label>

        <div className="row">
          <button className="primary" type="submit">
            {saved ? "Saved" : "Save"}
          </button>
          {draft.apiKey && (
            <button type="button" className="link danger" onClick={forgetKey}>
              Forget key
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}

function modelLabel(id: ModelId): string {
  return MODELS.find((m) => m.id === id)?.label.replace(/ \(.*\)$/, "") ?? id;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? `today at ${time}` : `${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}
