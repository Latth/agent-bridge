import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests',
  use: { baseURL: process.env.BASE_URL ?? 'https://app.staging.acme.dev', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
