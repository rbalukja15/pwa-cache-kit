// The demo works offline after one visit (#15): the service worker serves the app shell and the
// cache serves the tickets. Runs against `vite preview` of the built demo (playwright.config.ts).
import { expect, test, type Page } from '@playwright/test';

const TICKETS = 8;

/** Waits until the service worker controls the page, so later loads go through it. */
async function waitForServiceWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        resolve();
      });
    });
  });
}

test('loads once, then renders the tickets offline after a reload and in a new tab', async ({
  context,
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('ticket')).toHaveCount(TICKETS);
  await expect(page.getByTestId('source')).toHaveText('Loaded from the network.');
  await waitForServiceWorker(page);

  await context.setOffline(true);

  await page.reload();
  await expect(page.getByTestId('ticket')).toHaveCount(TICKETS);
  await expect(page.getByTestId('ticket').first()).toContainText('Northern Lights Orchestra');
  await expect(page.getByTestId('connection')).toHaveText('Offline');
  // SessionStorage survives the reload of this tab.
  await expect(page.getByTestId('source')).toHaveText('Served from SessionStorage.');

  // A new tab has no SessionStorage copy, so IndexedDB serves the tickets.
  const tab = await context.newPage();
  await tab.goto('/');
  await expect(tab.getByTestId('ticket')).toHaveCount(TICKETS);
  await expect(tab.getByTestId('source')).toHaveText('Served from IndexedDB.');

  await tab.getByTestId('refresh').click();
  await expect(tab.getByTestId('source')).toHaveText(
    'Could not reach the network; keeping your saved tickets.',
  );
  await expect(tab.getByTestId('ticket')).toHaveCount(TICKETS);
});

test('says so when the first visit is offline and nothing is saved', async ({ context, page }) => {
  await page.goto('/');
  await waitForServiceWorker(page);
  // Let the page finish caching each ticket, so no write reopens the database after the delete.
  await expect(
    page.locator('[data-testid="inspector-log"] li[data-type="set"][data-tier="indexeddb"]', {
      hasText: 'ticket/TW-9407',
    }),
  ).toBeVisible();
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('pwa-cache-kit:ticket-wallet');
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(new Error('could not delete the database'));
      };
    });
    sessionStorage.clear();
  });
  await context.setOffline(true);

  const tab = await context.newPage();
  await tab.goto('/');
  await expect(tab.getByTestId('source')).toHaveText(
    'You are offline and no tickets are saved on this device yet.',
  );
  await expect(tab.getByTestId('ticket')).toHaveCount(0);
});
