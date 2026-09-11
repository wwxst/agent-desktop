import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import '@agent-desktop/client/styles.css';

const root = document.querySelector<HTMLDivElement>('#root');

if (!root) {
  throw new Error('Renderer root element is missing.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
