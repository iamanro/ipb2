// Every Exercise tab renders without a script error: a guard for the split of
// modules/exercise/client/view.js into per-panel files, where a missing or
// circular import fails only at runtime, in the browser.
import { expect, test } from '@playwright/test';

const TABS = [
  'instructor',
  'requirements',
  'geography',
  'reports',
  'situation',
  'rfi',
  'collection',
  'products',
  'scenario',
  'activity',
];

test('each Exercise tab renders without script errors', async ({ page }) => {
  // A fresh install (CI) has no basemap/terrain/regions data: the 404s for
  // it, pmtiles' unhandled "Bad response code: 404" and Geography's "No
  // regions data" note are expected there.
  const EXPECTED = /Failed to load resource|Bad response code: 404|No regions data/;
  const errors = [];
  page.on('pageerror', (error) => {
    if (!EXPECTED.test(error.message)) errors.push(`${page.url()}: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && !EXPECTED.test(message.text()))
      errors.push(`${page.url()}: ${message.text()}`);
  });

  for (const tab of TABS) {
    await page.goto(`/exercise/?tab=${tab}`);
    await expect(page.locator(`button[data-tab="${tab}"]`)).toHaveClass(/\bactive\b/);
    // Let the tab's first load and render finish before moving on (the
    // live-update stream stays open, so the network never goes idle).
    await page.waitForTimeout(500);
    // The view catches a render failure and shows it in the panel instead of throwing.
    for (const text of await page.locator('.inline-error').allTextContents())
      if (text.trim() && !EXPECTED.test(text)) errors.push(`${tab}: ${text}`);
  }

  expect(errors).toEqual([]);
});
