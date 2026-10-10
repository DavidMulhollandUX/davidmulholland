import { useEffect, useRef, useState } from "react";
import type { RendererInbound, RendererOutbound } from "@/lib/protocol";

const RENDERER_URL = chrome.runtime.getURL("/renderer.html");

export function HomepageFrame({ tsx, onError }: { tsx: string; onError: (message: string | null) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent<RendererOutbound>) => {
      if (event.source !== frame.current?.contentWindow) return;
      const msg = event.data;
      switch (msg?.type) {
        case "ready":
          setReady(true);
          break;
        case "rendered":
          onError(null);
          break;
        case "render-error":
          onError(msg.message);
          break;
        case "navigate":
          if (!/^https?:\/\//i.test(msg.url)) return;
          if (msg.newTab) void chrome.tabs.create({ url: msg.url, active: false });
          else window.location.href = msg.url;
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onError]);

  useEffect(() => {
    if (!ready) return;
    const message: RendererInbound = { type: "render", tsx };
    frame.current?.contentWindow?.postMessage(message, "*");
  }, [ready, tsx]);

  return (
    <iframe
      ref={frame}
      className="homepage-frame"
      src={RENDERER_URL}
      title="Your homepage"
      sandbox="allow-scripts allow-popups"
    />
  );
}
