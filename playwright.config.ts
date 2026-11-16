import { defineConfig, devices } from '@playwright/test';

// Browser tests, run after `npm run build`:
// - packages/pwa-cache-kit/e2e: smoke tests of the built library. The page and dist files are
//   served by request routing in the tests, so they need no web server.
// - demo/e2e: the demo PWA, served by `vite preview`, since its service worker needs real HTTP.
// CHROMIUM_EXECUTABLE points Chromium at a preinstalled binary, for machines whose browsers do not
// match this Playwright version.
const executablePath = process.env['CHROMIUM_EXECUTABLE'];
const DEMO_URL = 'http://localhost:4174';

export default defineConfig({
  testDir: '.',
  testMatch: ['packages/*/e2e/*.spec.ts', 'demo/e2e/*.spec.ts'],
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { baseURL: DEMO_URL },
  webServer: {
    command: 'npm run preview -w pwa-cache-kit-demo',
    url: DEMO_URL,
    reuseExistingServer: !process.env['CI'],
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
