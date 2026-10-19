import type { AgentEvent, RendererApi } from "../../shared/types.js";

declare global {
  interface Window {
    api: RendererApi;
  }
}

export type { AgentEvent };
