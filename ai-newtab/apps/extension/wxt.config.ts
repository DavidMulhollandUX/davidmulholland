import { defineConfig } from "wxt";

// The renderer runs model-written code. It gets no network access at all;
// images may load from https so headlines can carry their thumbnails.
const SANDBOX_CSP = [
  "sandbox allow-scripts allow-popups",
  "default-src 'none'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src https: data:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join("; ");

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: ({ mode }) => ({
    name: "AI New Tab",
    description: "A new-tab homepage that Claude rebuilds from the sites you actually read.",
    permissions: ["history", "tabs", "scripting", "storage", "unlimitedStorage", "alarms"],
    // Pages are loaded in the user's own signed-in browser, so the scraper needs every origin.
    host_permissions: ["<all_urls>"],
    chrome_url_overrides: { newtab: "newtab.html" },
    // Dev mode serves scripts from the WXT dev server, which this CSP would block.
    ...(mode === "production" ? { content_security_policy: { sandbox: SANDBOX_CSP } } : {}),
  }),
});
