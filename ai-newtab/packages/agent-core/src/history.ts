import type { HistoryDomain, HistorySummary } from "./types.js";

/** Minimal shape shared by chrome.history.HistoryItem and the harness fixtures. */
export interface RawHistoryItem {
  url?: string;
  title?: string;
  lastVisitTime?: number;
  visitCount?: number;
  typedCount?: number;
}

// Pages that are private, transactional, or useless as homepage sources.
const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /(^|\.)google\.[a-z.]+$/, // search, accounts, mail, docs live under subdomains handled below
  /(^|\.)bing\.com$/,
  /(^|\.)duckduckgo\.com$/,
  /(^|\.)search\.yahoo\.com$/,
  /(^|\.)kagi\.com$/,
  /(^|\.)perplexity\.ai$/,
  /(^|\.)mail\./,
  /^outlook\.(live|office|office365)\.com$/,
  /(^|\.)proton(mail)?\.(me|com)$/,
  /(^|\.)fastmail\.com$/,
  /bank/,
  /(^|\.)paypal\.com$/,
  /(^|\.)stripe\.com$/,
  /(^|\.)venmo\.com$/,
  /(^|\.)wise\.com$/,
  /(^|\.)coinbase\.com$/,
  /(^|\.)chase\.com$/,
  /(^|\.)americanexpress\.com$/,
  /(^|\.)(accounts|login|auth|signin|sso|id)\./,
  /(^|\.)okta\.com$/,
  /(^|\.)1password\.com$/,
  /(^|\.)lastpass\.com$/,
  /(^|\.)bitwarden\.com$/,
  /(^|\.)anthropic\.com$/,
  /(^|\.)claude\.ai$/,
];

// Google properties that *are* useful sources.
const ALLOWED_GOOGLE_HOSTS = new Set(["news.google.com", "scholar.google.com"]);

const BLOCKED_PATH = /\/(login|logout|signin|sign-in|signup|sign-up|auth|oauth|checkout|cart|account|settings|password)(\/|$|\?)/i;

/** True for URLs the agent should never see or load. */
export function isBlockedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || /^[\d.]+$/.test(host) || host.includes(":")) {
    return true;
  }
  if (ALLOWED_GOOGLE_HOSTS.has(host)) return false;
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) return true;
  return BLOCKED_PATH.test(url.pathname);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Group history by domain and rank by "frecency": visits weighted by how
 * recently they happened, with typed visits counting extra.
 */
export function rankHistory(
  items: RawHistoryItem[],
  { days, limit, now = Date.now() }: { days: number; limit: number; now?: number },
): HistorySummary {
  const domains = new Map<string, HistoryDomain & { pageMap: Map<string, { url: string; title: string; visits: number; score: number }> }>();
  let totalVisits = 0;

  for (const item of items) {
    if (!item.url || isBlockedUrl(item.url)) continue;
    const last = item.lastVisitTime ?? now;
    if (now - last > days * DAY_MS) continue;
    const url = new URL(item.url);
    url.hash = "";
    const domain = url.hostname.replace(/^www\./, "").toLowerCase();
    const visits = item.visitCount ?? 1;
    const typed = item.typedCount ?? 0;
    const ageDays = Math.max(0, (now - last) / DAY_MS);
    const score = (visits + 2 * typed) * Math.exp(-ageDays / 3);
    totalVisits += visits;

    let entry = domains.get(domain);
    if (!entry) {
      entry = { domain, score: 0, visits: 0, typed: 0, lastVisit: new Date(last).toISOString(), pages: [], pageMap: new Map() };
      domains.set(domain, entry);
    }
    entry.score += score;
    entry.visits += visits;
    entry.typed += typed;
    if (last > Date.parse(entry.lastVisit)) entry.lastVisit = new Date(last).toISOString();

    const key = url.toString();
    const page = entry.pageMap.get(key);
    if (page) {
      page.visits += visits;
      page.score += score;
    } else {
      entry.pageMap.set(key, { url: key, title: (item.title ?? "").slice(0, 160), visits, score });
    }
  }

  const ranked = [...domains.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ pageMap, ...rest }) => ({
      ...rest,
      score: Math.round(rest.score * 10) / 10,
      pages: [...pageMap.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map(({ url, title, visits }) => ({ url, title, visits })),
    }));

  return { generatedAt: new Date(now).toISOString(), days, totalVisits, domains: ranked };
}
