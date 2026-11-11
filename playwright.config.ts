import { defineConfig } from '@playwright/test';

// End-to-end tests drive the production build in the locally installed Microsoft Edge (no browser download).
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  workers: 1,
  reporter: [['list']],
  use: { channel: 'msedge', headless: true, viewport: { width: 1360, height: 900 } },
});
