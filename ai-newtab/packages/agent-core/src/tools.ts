import type Anthropic from "@anthropic-ai/sdk";

/** Hard cap on pages loaded per build. */
export const MAX_PAGES = 8;

type AgentTool = Anthropic.Beta.AgentCreateParams["tools"] extends (infer T)[] | null | undefined ? T : never;

export const CUSTOM_TOOLS: AgentTool[] = [
  {
    type: "custom",
    name: "getHistory",
    description:
      "Return the person's recent browsing history from their browser, grouped by domain and ranked by how often and how recently they visit. Each domain includes a few sample pages with titles and URLs. Call this once, first.",
    input_schema: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          description: "How many days of history to include. 1-30, default 7.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of domains to return. 5-60, default 40.",
        },
      },
    },
  },
  {
    type: "custom",
    name: "getPageHtml",
    description: `Load up to ${MAX_PAGES} pages in the person's signed-in browser, clean the HTML (scripts, styles and most attributes removed, links made absolute) and mount each one as a file under /mnt/session/uploads/pages/. Returns the file path for each URL, or the reason it could not be loaded. Pass every URL you want in a single call; the ${MAX_PAGES}-page limit is per build.`,
    input_schema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "Absolute http(s) URLs taken from the getHistory results.",
        },
      },
      required: ["urls"],
    },
  },
];

export const AGENT_TOOLS: AgentTool[] = [
  {
    type: "agent_toolset_20260401",
    // File tools only: the agent reads mounted pages and writes one file. No shell, no web.
    default_config: { enabled: false },
    configs: [
      { name: "read", enabled: true, permission_policy: { type: "always_allow" } },
      { name: "write", enabled: true, permission_policy: { type: "always_allow" } },
      { name: "edit", enabled: true, permission_policy: { type: "always_allow" } },
      { name: "glob", enabled: true, permission_policy: { type: "always_allow" } },
      { name: "grep", enabled: true, permission_policy: { type: "always_allow" } },
    ],
  },
  ...CUSTOM_TOOLS,
];

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? Math.round(value) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
