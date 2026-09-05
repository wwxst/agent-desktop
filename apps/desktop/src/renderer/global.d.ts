import type { DesktopApi } from '../shared/ipc.js';

declare global {
  interface Window {
    agentDesktop: DesktopApi;
  }
}

export {};
