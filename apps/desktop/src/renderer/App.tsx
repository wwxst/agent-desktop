import { App as SharedApp } from '@agent-desktop/client';

/** Desktop 入口仅把 preload 注入的宿主能力显式传给共享 Client。 */
export function App() {
  return <SharedApp api={window.agentDesktop} />;
}
