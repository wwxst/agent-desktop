import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@agent-desktop/client';
import { createWebClientApi } from './webClientApi.js';
import '../../../packages/client/src/styles.css';

const root = document.querySelector<HTMLDivElement>('#root');
if (!root) throw new Error('Web client root element is missing.');

createRoot(root).render(
  <StrictMode>
    <App api={createWebClientApi()} />
  </StrictMode>,
);
