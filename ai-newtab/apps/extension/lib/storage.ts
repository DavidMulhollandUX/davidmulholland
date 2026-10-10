import { DEFAULT_MODEL, type BuildCheckpoint, type InfraIds, type ModelId } from "@ai-newtab/agent-core";

export interface Settings {
  apiKey: string;
  model: ModelId;
  instructions: string;
  /** 0 = off. Scheduling starts after the first successful build. */
  autoRebuildHours: 0 | 6 | 12 | 24 | 48;
}

export interface Homepage {
  tsx: string;
  builtAt: string;
  model: ModelId;
  pageCount: number;
  summary: string;
}

export type BuildStatus = "idle" | "running" | "interrupted" | "error" | "done";

export interface BuildState {
  status: BuildStatus;
  trigger: "manual" | "scheduled" | "resume" | null;
  model: ModelId | null;
  startedAt: string | null;
  finishedAt: string | null;
  steps: { at: string; text: string }[];
  error: string | null;
  /** Present while a session exists that a resume could pick up. */
  checkpoint: BuildCheckpoint | null;
}

export interface StoreShape {
  settings: Settings;
  infra: InfraIds | null;
  homepage: Homepage | null;
  buildState: BuildState;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: DEFAULT_MODEL,
  instructions: "",
  autoRebuildHours: 0,
};

export const IDLE_BUILD: BuildState = {
  status: "idle",
  trigger: null,
  model: null,
  startedAt: null,
  finishedAt: null,
  steps: [],
  error: null,
  checkpoint: null,
};

const DEFAULTS: StoreShape = {
  settings: DEFAULT_SETTINGS,
  infra: null,
  homepage: null,
  buildState: IDLE_BUILD,
};

export async function load<K extends keyof StoreShape>(key: K): Promise<StoreShape[K]> {
  const result = await chrome.storage.local.get(key);
  const value = result[key] as StoreShape[K] | undefined;
  if (value === undefined) return DEFAULTS[key];
  if (key === "settings") return { ...DEFAULT_SETTINGS, ...(value as Settings) } as StoreShape[K];
  return value;
}

export async function save<K extends keyof StoreShape>(key: K, value: StoreShape[K]): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

/** Subscribe to changes of one key. Returns an unsubscribe function. */
export function watch<K extends keyof StoreShape>(key: K, cb: (value: StoreShape[K]) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && key in changes) cb((changes[key].newValue as StoreShape[K] | undefined) ?? DEFAULTS[key]);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
