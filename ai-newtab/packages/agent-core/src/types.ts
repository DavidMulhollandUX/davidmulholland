/** Ranked browsing-history summary returned by the `getHistory` tool. */
export interface HistorySummary {
  generatedAt: string;
  days: number;
  totalVisits: number;
  domains: HistoryDomain[];
}

export interface HistoryDomain {
  domain: string;
  score: number;
  visits: number;
  typed: number;
  lastVisit: string;
  pages: { url: string; title: string; visits: number }[];
}

/** One page captured by the host for the `getPageHtml` tool. */
export type PageCapture =
  | { ok: true; url: string; finalUrl: string; title: string; html: string }
  | { ok: false; url: string; error: string };

/**
 * The capabilities a host (Chrome extension, Node harness) must provide.
 * Custom tools run here because they need the user's browser.
 */
export interface ToolHost {
  getHistory(input: { days: number; limit: number }): Promise<HistorySummary>;
  getPageHtml(urls: string[]): Promise<PageCapture[]>;
}

export type ModelId = "claude-sonnet-5-5" | "claude-haiku-5-5" | "claude-opus-5-5";

export const MODELS: { id: ModelId; label: string }[] = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (default)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (most capable)" },
];

export const DEFAULT_MODEL: ModelId = "claude-sonnet-5-5";

/** IDs of the persisted agent + environment, created once per API key. */
export interface InfraIds {
  agentId: string;
  environmentId: string;
  /** AGENT_CONFIG_VERSION the agent was last synced to. */
  configVersion: number;
}

/** Everything needed to resume an interrupted build. */
export interface BuildCheckpoint {
  sessionId: string;
  uploadedFileIds: string[];
  pagesFetched: number;
  pageCount: number;
}

export interface BuildResult {
  tsx: string;
  sessionId: string;
  pageCount: number;
  summary: string;
}

export interface BuildCallbacks {
  /** Human-readable progress line for the UI. */
  onProgress(text: string): void;
  /** Persist state so a build can resume if the host is torn down. */
  onCheckpoint(checkpoint: BuildCheckpoint): void | Promise<void>;
}
