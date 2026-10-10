/** Messages the new-tab page sends to the service worker. */
export type ExtensionRequest =
  | { type: "build" }
  | { type: "resume" }
  | { type: "cancel" }
  | { type: "settings-updated" };

export interface ExtensionResponse {
  ok: boolean;
  error?: string;
}

/** Messages exchanged between the new-tab page and the sandboxed renderer iframe. */
export type RendererInbound = { type: "render"; tsx: string };
export type RendererOutbound =
  | { type: "ready" }
  | { type: "rendered" }
  | { type: "render-error"; message: string }
  | { type: "navigate"; url: string; newTab: boolean };

export function send(request: ExtensionRequest): Promise<ExtensionResponse> {
  return chrome.runtime.sendMessage(request);
}
