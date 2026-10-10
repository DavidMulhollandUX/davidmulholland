/**
 * Sandboxed renderer for the model-written homepage component.
 *
 * This page is listed under the manifest's `sandbox` key: it runs in a unique
 * opaque origin with no access to chrome.* APIs or extension storage (so the
 * generated code can never read the API key), and its CSP blocks network
 * requests. It receives TSX over postMessage, compiles it with Sucrase and
 * renders it with React.
 */
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import { createRoot, type Root } from "react-dom/client";
import { transform } from "sucrase";
import type { RendererInbound, RendererOutbound } from "@/lib/protocol";

const MODULES: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": JsxRuntime,
  "react/jsx-dev-runtime": JsxRuntime,
};

function post(message: RendererOutbound) {
  window.parent.postMessage(message, "*");
}

function compile(tsx: string): React.ComponentType {
  const { code } = transform(tsx, {
    transforms: ["typescript", "jsx", "imports"],
    jsxRuntime: "automatic",
    production: true,
  });
  const module = { exports: {} as Record<string, unknown> };
  const require = (name: string) => {
    if (name in MODULES) return MODULES[name];
    throw new Error(`The homepage imports "${name}", but only "react" is available.`);
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("require", "module", "exports", code)(require, module, module.exports);
  const component = (module.exports.default ?? Object.values(module.exports).find((v) => typeof v === "function")) as
    | React.ComponentType
    | undefined;
  if (typeof component !== "function") throw new Error("The homepage file has no default-exported component.");
  return component;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    post({ type: "render-error", message: error.message });
  }
  render() {
    return this.state.error ? null : this.props.children;
  }
}

/** Commits only if the homepage rendered without throwing. */
function Rendered() {
  React.useEffect(() => post({ type: "rendered" }), []);
  return null;
}

let root: Root | null = null;

function render(tsx: string) {
  const container = document.getElementById("root")!;
  root?.unmount();
  root = createRoot(container);
  try {
    const Homepage = compile(tsx);
    root.render(
      <ErrorBoundary>
        <Homepage />
        <Rendered />
      </ErrorBoundary>,
    );
  } catch (err) {
    post({ type: "render-error", message: err instanceof Error ? err.message : String(err) });
  }
}

window.addEventListener("message", (event: MessageEvent<RendererInbound>) => {
  if (event.source !== window.parent || event.data?.type !== "render") return;
  render(event.data.tsx);
});

// Links can't navigate the top frame from a sandbox; hand them to the new-tab page.
document.addEventListener(
  "click",
  (event) => {
    const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;
    event.preventDefault();
    const url = anchor.href;
    if (!/^https?:\/\//i.test(url)) return;
    post({ type: "navigate", url, newTab: event.metaKey || event.ctrlKey || event.shiftKey || anchor.target === "_blank" });
  },
  true,
);
document.addEventListener(
  "auxclick",
  (event) => {
    const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor || event.button !== 1) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(anchor.href)) post({ type: "navigate", url: anchor.href, newTab: true });
  },
  true,
);

post({ type: "ready" });
