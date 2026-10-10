import { rankHistory, type HistorySummary } from "@ai-newtab/agent-core";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getRankedHistory({ days, limit }: { days: number; limit: number }): Promise<HistorySummary> {
  const items = await chrome.history.search({
    text: "",
    startTime: Date.now() - days * DAY_MS,
    maxResults: 10_000,
  });
  return rankHistory(items, { days, limit });
}
