// Every IPB step, the guide and the map menus render without a script error.
// A guard for the split of modules/ipb/client/view.js into per-step files: a
// missing or circular import there fails only at runtime, in the browser.
import { expect, test } from '@playwright/test';

test('each IPB step worksheet renders without script errors', async ({ page, request }) => {
  // A fresh install (CI) has no basemap/terrain data: the 404s for it, and
  // pmtiles' unhandled "Bad response code: 404", are expected there.
  const EXPECTED = /Failed to load resource|Bad response code: 404/;
  const errors = [];
  page.on('pageerror', (error) => {
    if (!EXPECTED.test(error.message)) errors.push(error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && !EXPECTED.test(message.text())) errors.push(message.text());
  });

  const response = await request.post('/api/ipb/studies', {
    data: { name: 'e2e steps', bounds: [16.5, 49.1, 16.7, 49.3] },
  });
  const study = await response.json();

  for (const step of [1, 2, 3, 4]) {
    await page.goto(`/ipb/?study=${study.id}&step=${step}`);
    await expect(page.locator('#worksheet-study-name')).toHaveText(study.name);
    const worksheet = page.locator(`#worksheet-${step}`);
    await expect(worksheet).toBeVisible();
    await expect(worksheet.locator('*').first()).toBeAttached();
    // The view catches some render failures and shows them inline instead.
    for (const text of await page.locator('.inline-error').allTextContents())
      if (text.trim() && !EXPECTED.test(text)) errors.push(`step ${step}: ${text}`);
  }

  // The map's right-click menu (menus.js) and the guide panel (toolPanel.js).
  const box = await page.locator('.ol-viewport').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(page.locator('.context-menu')).toBeVisible();
  await page.keyboard.press('Escape');

  expect(errors).toEqual([]);
});
