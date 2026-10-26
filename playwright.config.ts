import { defineConfig, devices } from '@playwright/test';

// Browser smoke tests of the built library (`npm run build` first). The page and dist files are
// served by request routing in the tests, so no web server runs.
// CHROMIUM_EXECUTABLE points Chromium at a preinstalled binary, for machines whose browsers do not
// match this Playwright version.
const executablePath = process.env['CHROMIUM_EXECUTABLE'];

export default defineConfig({
  testDir: 'packages/pwa-cache-kit/e2e',
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? 'github' : 'list',
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
