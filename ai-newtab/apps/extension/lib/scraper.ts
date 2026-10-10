import { isBlockedUrl, type PageCapture } from "@ai-newtab/agent-core";

const LOAD_TIMEOUT_MS = 25_000;
const SETTLE_MS = 1_500;
const MAX_HTML_CHARS = 400_000;
const CONCURRENCY = 4;

/**
 * Open each URL in a minimized background window (so the user's cookies and
 * sign-ins apply), let it render and lazy-load, then extract cleaned HTML.
 */
export async function capturePages(urls: string[]): Promise<PageCapture[]> {
  const results = new Map<string, PageCapture>();
  const allowed: string[] = [];
  for (const url of urls) {
    if (isBlockedUrl(url)) results.set(url, { ok: false, url, error: "blocked: private, search, mail, banking or non-web page" });
    else allowed.push(url);
  }
  if (allowed.length === 0) return urls.map((url) => results.get(url)!);

  const win = await chrome.windows.create({ url: "about:blank", focused: false, state: "minimized" });
  const windowId = win.id!;
  try {
    const queue = [...allowed];
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (let url = queue.shift(); url; url = queue.shift()) {
          results.set(url, await captureOne(windowId, url));
        }
      }),
    );
  } finally {
    await chrome.windows.remove(windowId).catch(() => {});
  }
  return urls.map((url) => results.get(url)!);
}

async function captureOne(windowId: number, url: string): Promise<PageCapture> {
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ windowId, url, active: false });
    tabId = tab.id!;
    // Muted so autoplaying media in the background window stays silent.
    await chrome.tabs.update(tabId, { muted: true }).catch(() => {});
    await waitForLoad(tabId);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const loaded = await chrome.tabs.get(tabId);
    if (loaded.url && isBlockedUrl(loaded.url)) {
      return { ok: false, url, error: `redirected to a blocked page (${new URL(loaded.url).hostname}); probably a login wall` };
    }
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPage,
      args: [MAX_HTML_CHARS],
    });
    const page = injection?.result as { title: string; url: string; html: string } | undefined;
    if (!page || page.html.length < 200) return { ok: false, url, error: "page was empty after loading" };
    return { ok: true, url, finalUrl: page.url, title: page.title, html: page.html };
  } catch (err) {
    return { ok: false, url, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => {});
  }
}

function waitForLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      // Slow pages usually have their content by now; extract what's there.
      resolve();
    }, LOAD_TIMEOUT_MS);
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") {
        cleanup();
        resolve();
      }
    };
    const removed = (id: number) => {
      if (id === tabId) {
        cleanup();
        reject(new Error("tab closed while loading"));
      }
    };
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removed);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removed);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        cleanup();
        resolve();
      }
    }, () => {});
  });
}

/**
 * Runs inside the page. Must be self-contained: it is serialized and injected.
 * Scrolls to trigger lazy loading, then returns the body as compact HTML with
 * only content-bearing attributes and absolute links.
 */
export async function extractPage(maxChars: number): Promise<{ title: string; url: string; html: string }> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 5; i++) {
    window.scrollBy(0, window.innerHeight * 1.5);
    await sleep(300);
  }
  window.scrollTo(0, 0);

  const clone = document.body.cloneNode(true) as HTMLElement;
  const DROP =
    "script,style,noscript,svg,canvas,iframe,video,audio,source,template,link,meta,input,select,textarea,form button,dialog,[hidden],[aria-hidden='true']";
  clone.querySelectorAll(DROP).forEach((el) => el.remove());

  const KEEP = new Set(["href", "src", "alt", "title", "datetime", "aria-label"]);
  for (const el of Array.from(clone.querySelectorAll("*"))) {
    if (el instanceof HTMLImageElement) {
      const lazy = el.getAttribute("data-src") || el.getAttribute("data-lazy-src");
      const src = el.currentSrc || el.src;
      const best = src && !src.startsWith("data:") ? src : lazy ? new URL(lazy, document.baseURI).href : "";
      if (best) el.setAttribute("src", best);
      else el.removeAttribute("src");
    }
    if (el instanceof HTMLAnchorElement) {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("javascript:") && !href.startsWith("#")) el.setAttribute("href", el.href);
      else el.removeAttribute("href");
    }
    for (const attr of Array.from(el.attributes)) {
      if (!KEEP.has(attr.name)) el.removeAttribute(attr.name);
    }
  }

  let html = clone.innerHTML.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
  // Collapse wrappers left empty by the stripping above.
  for (let i = 0; i < 4; i++) {
    html = html.replace(/<(div|span|p|li|ul|section|figure|i|b)>\s*<\/\1>/g, "");
  }
  html = html.replace(/>\s+</g, "><").trim();
  if (html.length > maxChars) html = `${html.slice(0, maxChars)}<!-- truncated -->`;
  return { title: document.title, url: location.href, html };
}
