// Real-browser checks for map interactions: bugs here slipped past synthetic
// `.click()` / `dispatchEvent` tests because they live in the real
// mousedown -> mouseup -> click and keyboard sequences, print layout, and
// browser storage. Playwright drives real input events.
import { expect, test } from '@playwright/test';

/** The IPB map opens at this centre (view.js DEFAULT_CENTER) without an AOI. */
const MAP_CENTRE = [17.5, 49.7];

async function openStudy(page, request) {
  const response = await request.post('/api/ipb/studies', {
    data: { name: `e2e ${test.info().title.slice(0, 40)}` },
  });
  const study = await response.json();
  await page.goto(`/ipb/?study=${study.id}&step=1`);
  await expect(page.locator('#map-empty')).toBeHidden();
  return study;
}

async function rightClickMap(page, fx = 0.5, fy = 0.5) {
  const box = await page.locator('.ol-viewport').boundingBox();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy, { button: 'right' });
  await expect(page.locator('.context-menu')).toBeVisible();
}

const menuItem = (page, label) => page.locator('.context-menu-item', { hasText: label }).first();

async function featuresOf(request, study) {
  return (await (await request.get(`/api/ipb/studies/${study.id}`)).json()).features;
}

test('context menu "Copy coordinates" puts an MGRS reference on the clipboard', async ({
  page,
  request,
}) => {
  await openStudy(page, request);
  await rightClickMap(page);
  await menuItem(page, 'Copy coordinates').click();
  await expect(page.locator('.ipb-toast')).toContainText('Copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^\d{1,2}[C-X][A-Z]{2}\d{10}$/);
});

test('a point placed from the context menu saves the label typed before Enter', async ({
  page,
  request,
}) => {
  const study = await openStudy(page, request);
  await rightClickMap(page);
  await menuItem(page, 'Draw here').click();
  await menuItem(page, 'Key terrain').click();
  await menuItem(page, 'Point here').click();
  const input = page.locator('dialog[open] input');
  await input.fill('Hill 402');
  await input.press('Enter');
  await expect
    .poll(async () => (await featuresOf(request, study)).map((feature) => feature.label))
    .toEqual(['Hill 402']);
});

test('Enter on the Delete confirmation keeps the feature (Cancel is the default)', async ({
  page,
  request,
}) => {
  const study = await openStudy(page, request);
  await request.post(`/api/ipb/studies/${study.id}/features`, {
    data: {
      layer: 'key-terrain',
      kind: 'point',
      label: 'Keep me',
      geometry: { type: 'Point', coordinates: MAP_CENTRE },
    },
  });
  await page.reload();
  await expect(page.locator('#map-empty')).toBeHidden();
  // The feature at the map centre is hit-testable only once drawn; retry.
  await expect(async () => {
    await rightClickMap(page);
    await expect(menuItem(page, 'Delete')).toBeVisible({ timeout: 500 });
  }).toPass();
  await menuItem(page, 'Delete').click();
  await expect(page.locator('dialog[open]')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('dialog[open]')).toBeHidden();
  expect((await featuresOf(request, study)).map((feature) => feature.label)).toEqual(['Keep me']);
});

test('printing includes a snapshot of the map although print styles hide the map', async ({
  page,
  request,
}) => {
  const study = await openStudy(page, request);
  // Let the map settle so its frame snapshot is taken (view.js/map.js).
  await page.waitForTimeout(1500);
  // Record what the print figure holds while printing; afterprint clears it.
  await page.evaluate(() => {
    window.addEventListener('beforeprint', () => {
      const figure = document.querySelector('#print-map');
      const canvas = figure.querySelector('canvas');
      let opaque = 0;
      if (canvas?.width) {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let index = 3; index < pixels.length; index += 4 * 101) if (pixels[index]) opaque += 1;
      }
      window.printedMap = { width: canvas?.width ?? 0, opaque, caption: figure.textContent };
    });
  });
  await page.pdf({ format: 'A4' });
  const printed = await page.evaluate(() => window.printedMap);
  expect(printed.width).toBeGreaterThan(0);
  expect(printed.opaque).toBeGreaterThan(0);
  expect(printed.caption).toContain(study.name);
});

test('the MGRS grid toggle survives a reload', async ({ page, request }) => {
  await openStudy(page, request);
  const toggle = page.locator('#grid-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(page.locator('#grid-toggle')).toHaveAttribute('aria-pressed', 'false');
});
