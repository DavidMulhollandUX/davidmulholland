import { readFile } from "node:fs/promises";
import { isBlockedUrl, rankHistory, type PageCapture, type RawHistoryItem, type ToolHost } from "@ai-newtab/agent-core";

/**
 * A ToolHost for running builds outside Chrome. History comes from a JSON
 * fixture; pages are fetched logged-out over plain HTTP and cleaned with
 * regexes, so results are rougher than the extension's signed-in captures.
 */
export function createNodeHost(historyPath: string): ToolHost {
  return {
    async getHistory({ days, limit }) {
      const items = JSON.parse(await readFile(historyPath, "utf8")) as RawHistoryItem[];
      const now = Date.now();
      // Fixtures have no timestamps; spread them over the last day.
      const stamped = items.map((item, i) => ({ ...item, lastVisitTime: item.lastVisitTime ?? now - i * 3_600_000 }));
      return rankHistory(stamped, { days, limit, now });
    },
    async getPageHtml(urls) {
      return Promise.all(urls.map(fetchPage));
    },
  };
}

async function fetchPage(url: string): Promise<PageCapture> {
  if (isBlockedUrl(url)) return { ok: false, url, error: "blocked: private, search, mail, banking or non-web page" };
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; ai-newtab-harness)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, url, error: `HTTP ${res.status}` };
    const raw = await res.text();
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim() ?? "";
    return { ok: true, url, finalUrl: res.url, title, html: cleanHtml(raw, res.url) };
  } catch (err) {
    return { ok: false, url, error: err instanceof Error ? err.message : String(err) };
  }
}

export function cleanHtml(raw: string, base: string): string {
  let html = /<body[^>]*>([\s\S]*)<\/body>/i.exec(raw)?.[1] ?? raw;
  html = html
    .replace(/<(script|style|noscript|svg|iframe|template)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Keep href/src/alt/title/datetime; drop every other attribute.
    .replace(/<([a-z][a-z0-9]*)\b([^>]*)>/gi, (_m, tag: string, attrs: string) => {
      const kept: string[] = [];
      for (const [, name, value] of attrs.matchAll(/([a-z-:]+)\s*=\s*("[^"]*"|'[^']*')/gi)) {
        const lower = name.toLowerCase();
        if (!["href", "src", "alt", "title", "datetime"].includes(lower)) continue;
        let v = value.slice(1, -1);
        if (lower === "href" || lower === "src") {
          try {
            v = new URL(v.replace(/&amp;/g, "&"), base).href;
          } catch {
            continue;
          }
        }
        kept.push(`${lower}="${v.replace(/"/g, "&quot;")}"`);
      }
      return `<${tag}${kept.length ? ` ${kept.join(" ")}` : ""}>`;
    })
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><");
  return html.length > 400_000 ? `${html.slice(0, 400_000)}<!-- truncated -->` : html;
}
