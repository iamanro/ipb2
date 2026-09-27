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
  await expectStudyOpen(page, study);
  return study;
}

/** Not `#map-empty` hidden: that passes before the module has mounted the
 * empty-state overlay, and a click on the map then lands on it. */
async function expectStudyOpen(page, study) {
  await expect(page.locator('#worksheet-study-name')).toHaveText(study.name);
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
  await expectStudyOpen(page, study);
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
  // The grid switch lives in the Map popover, with the other overlays.
  await page.locator('#map-menu-toggle').click();
  const toggle = page.getByRole('button', { name: 'MGRS grid', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(page.locator('#grid-toggle')).toHaveAttribute('aria-pressed', 'false');
});

test('a point added by clicking the map keeps its name and multi-line note', async ({
  page,
  request,
}) => {
  const study = await openStudy(page, request);
  const layer = await (
    await request.post(`/api/ipb/studies/${study.id}/layers`, { data: { name: 'Contacts' } })
  ).json();
  await page.reload();
  // Custom layers live under the guide's "More tools".
  await page.getByText('More tools').click();
  await page.locator('.custom-layer-name', { hasText: 'Contacts' }).click();
  await page.getByRole('button', { name: 'Add on map' }).click();
  const box = await page.locator('.ol-viewport').boundingBox();
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
  // Fields: name, position (prefilled from the click), note.
  const name = page.locator('dialog[open] .dialog-field input').first();
  const note = page.locator('dialog[open] .dialog-field textarea');
  await name.fill('Contact A');
  // Enter in the note is a new line; Enter in the name saves.
  await note.click();
  await note.pressSequentially('Two BMPs');
  await note.press('Enter');
  await note.pressSequentially('moving north');
  await expect(page.locator('dialog[open]')).toBeVisible();
  await name.press('Enter');
  await expect
    .poll(async () => (await (await request.get(`/api/ipb/studies/${study.id}`)).json()).points)
    .toMatchObject([{ layer_id: layer.id, name: 'Contact A', note: 'Two BMPs\nmoving north' }]);
  await page.reload();
  await page.getByText('More tools').click();
  await page.locator('.custom-layer-name', { hasText: 'Contacts' }).click();
  await expect(page.locator('.custom-point')).toContainText('Contact A');
});

test('holding the right button while drawing traces an area, simplified, with no context menu', async ({
  page,
  request,
}) => {
  const study = await openStudy(page, request);
  await page.locator('.area-tool').first().getByRole('button', { name: 'Draw' }).click();
  const box = await page.locator('.ol-viewport').boundingBox();
  const cx = box.x + box.width * 0.45;
  const cy = box.y + box.height * 0.5;
  await page.mouse.move(cx + 150, cy);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 400; i += 1) {
    const angle = (i / 400) * 2 * Math.PI;
    await page.mouse.move(cx + 150 * Math.cos(angle), cy + 100 * Math.sin(angle));
  }
  await page.mouse.up({ button: 'right' });
  await expect(page.locator('.context-menu')).toHaveCount(0);
  await expect
    .poll(async () => (await (await request.get(`/api/ipb/studies/${study.id}`)).json()).study.ao)
    .not.toBeNull();
  const { study: saved } = await (await request.get(`/api/ipb/studies/${study.id}`)).json();
  const corners = saved.ao.coordinates[0].length - 1;
  // Every pointer move is sampled; only the corners that show at 2 px are kept.
  expect(corners).toBeGreaterThanOrEqual(8);
  expect(corners).toBeLessThan(80);
});

test('coming back to IPB from another module reopens the study and step', async ({
  page,
  request,
}) => {
  const study = await openStudy(page, request);
  await page.getByRole('button', { name: /3\s*Threat/ }).click();
  await page.getByRole('link', { name: 'Exercise' }).click();
  await expect(page).toHaveURL(/\/exercise\//);
  await page.getByRole('link', { name: 'IPB' }).click();
  await expectStudyOpen(page, study);
  await expect(page).toHaveURL(new RegExp(`study=${study.id}&step=3`));
});

test('the guide opens the first task, ticks it from the data and moves on with Next', async ({
  page,
  request,
}) => {
  const study = await openStudy(page, request);
  const task = (id) => page.locator(`.guide-task[data-task="${id}"]`);
  await expect(task('ao').locator('.guide-task-head')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.step-tab[data-step="1"] .step-progress')).toHaveText('0/4');

  await task('ao').getByRole('button', { name: 'Enter coordinates…' }).click();
  await page.locator('.area-editor-text').fill('49.65, 17.40\n49.65, 17.55\n49.75, 17.55');
  await page.locator('.area-editor .dialog-accept').click();
  await expect(task('ao')).toHaveAttribute('data-status', 'done');
  await expect(page.locator('.step-tab[data-step="1"] .step-progress')).toHaveText('1/4');

  await task('ao')
    .getByRole('button', { name: /Next: 1\.2 Area of interest/ })
    .click();
  await expect(task('aoi').locator('.guide-task-head')).toHaveAttribute('aria-expanded', 'true');

  // A review task is ticked by hand, shared through the study.
  await task('weather').locator('.guide-task-head').click();
  await task('weather').getByRole('button', { name: 'Mark done / skip' }).click();
  await expect(task('weather')).toHaveAttribute('data-status', 'checked');
  await expect
    .poll(
      async () => (await (await request.get(`/api/ipb/studies/${study.id}`)).json()).study.checked,
    )
    .toEqual(['weather']);
});

test('the forecast request to Open-Meteo carries no custom header (it would fail CORS)', async ({
  page,
  request,
}) => {
  const forecastHeaders = [];
  // Open-Meteo allows only standard headers; a custom one makes the real
  // browser drop the request after its preflight ("Unavailable").
  await page.route('https://api.open-meteo.com/**', async (route) => {
    forecastHeaders.push(route.request().headers());
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: { latitude: 49.7, longitude: 17.5, current: { time: 0 }, hourly: { time: [0] } },
    });
  });
  await openStudy(page, request);
  await page.locator('.weather-forecast').getByRole('button', { name: 'Get weather' }).click();
  await expect.poll(() => forecastHeaders.length).toBeGreaterThan(0);
  expect(forecastHeaders[0]).not.toHaveProperty('x-client-id');
  await expect(page.locator('.weather-forecast')).not.toContainText('Unavailable');
});
