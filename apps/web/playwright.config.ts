import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const WEB_CLIENT_URL = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.pw.ts',
  reporter: 'line',
  use: {
    baseURL: WEB_CLIENT_URL,
    browserName: 'chromium',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'chromium-800x600',
      use: { viewport: { width: 800, height: 600 } },
    },
  ],
  webServer: {
    command: 'corepack pnpm client:web --host 127.0.0.1 --port 4173 --strictPort',
    cwd: resolve(import.meta.dirname, '../..'),
    url: WEB_CLIENT_URL,
    reuseExistingServer: false,
  },
});
