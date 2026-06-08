import type { EclApi } from "../../electron/preload";

declare global {
  interface Window {
    api: EclApi;
  }
}

export {};
