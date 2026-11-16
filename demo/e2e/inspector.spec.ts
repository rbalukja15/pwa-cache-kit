// The cache inspector in the demo (#16): each read shows up with the tier that served it, and the
// storage-pressure switch makes the tiers evict. Runs against `vite preview` of the built demo.
import { expect, test } from '@playwright/test';

// Playwright's CSS locators pierce the inspector's open shadow root.
const log = '[data-testid="inspector-log"] li';

test('shows which tier served each read', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('ticket')).toHaveCount(8);
  await expect(
    page.locator(`${log}[data-type="set"][data-tier="indexeddb"]`, { hasText: 'wallet/tickets' }),
  ).toContainText('stored in indexeddb (load');

  // After a reload memory is empty and SessionStorage serves the list.
  await page.reload();
  await expect(
    page.locator(`${log}[data-type="hit"]`, { hasText: 'wallet/tickets served by session' }),
  ).toBeVisible();
  await expect(page.locator(`${log}[data-type="miss"][data-tier="memory"]`).first()).toBeVisible();

  // Opening a ticket is a read of its own key, cached in memory when the list loaded.
  await page.getByTestId('show-code').first().click();
  await expect(
    page.locator(`${log}[data-type="hit"]`, { hasText: 'ticket/TW-4821 served by memory' }),
  ).toBeVisible();
  await expect(page.locator('[data-key="ticket/TW-4821"]')).toContainText('fresh for');
});

test('evicts in every tier under simulated storage pressure', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('ticket')).toHaveCount(8);
  await expect(
    page.locator(`${log}[data-type="set"][data-tier="indexeddb"]`, { hasText: 'ticket/TW-9407' }),
  ).toBeVisible();

  await page.getByTestId('inspector-pressure').check();

  for (const tier of ['memory', 'session', 'indexeddb']) {
    // IndexedDB evicts in its sweep, which runs every two seconds under pressure.
    await expect(
      page.locator(`${log}[data-type="evict"][data-tier="${tier}"]`).first(),
    ).toBeVisible({ timeout: 10_000 });
  }
  await expect(page.locator('tr.evicted').first()).toBeVisible();
  await expect(page.getByTestId('ticket')).toHaveCount(8);
});
