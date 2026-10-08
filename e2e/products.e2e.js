// Graphic INTSUM printing (backlog gate 3): Print preview straight after
// opening Products used to print the legend with no map, and a single track
// zoomed the map to its last level ("~1 px ≈ 0 m").
import { expect, test } from '@playwright/test';

/** Records what the graphic INTSUM print figure holds when print starts, instead of printing. */
async function stubPrint(page) {
  await page.addInitScript(() => {
    window.print = () => {
      window.dispatchEvent(new Event('beforeprint'));
      const figure = document.querySelector('.graphic-intsum-print-map');
      const canvas = figure?.querySelector('canvas');
      let opaque = 0;
      if (canvas?.width) {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let index = 3; index < pixels.length; index += 4 * 101) if (pixels[index]) opaque += 1;
      }
      window.printedMap = {
        width: canvas?.width ?? 0,
        opaque,
        missing: Boolean(figure?.querySelector('.print-map-missing')),
        caption: figure?.querySelector('figcaption')?.textContent ?? '',
      };
      window.dispatchEvent(new Event('afterprint'));
    };
  });
}

async function printGraphicIntsumOnArrival(page) {
  await page.goto('/exercise/?tab=products');
  // No settling wait: the click lands as soon as the button exists.
  await page
    .locator('[data-product="graphic"]')
    .getByRole('button', { name: 'Print preview' })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.printedMap ?? null), { timeout: 20_000 })
    .not.toBeNull();
  return page.evaluate(() => window.printedMap);
}

test('graphic INTSUM printed right after opening Products carries the map, at a useful scale', async ({
  page,
  request,
}) => {
  const created = await request.post('/api/exercise/tracks', {
    data: {
      sidc: '10061000001211000000',
      designation: 'e2e lone track',
      status: 'confirmed',
      lon: 16.6,
      lat: 49.2,
      observed_at: '2026-09-28T10:00:00.000Z',
    },
  });
  expect(created.ok()).toBe(true);
  await stubPrint(page);

  const printed = await printGraphicIntsumOnArrival(page);
  expect(printed.missing).toBe(false);
  expect(printed.width).toBeGreaterThan(0);
  expect(printed.opaque).toBeGreaterThan(0);
  expect(printed.caption).toContain('scale bar on map');
  // The lone track keeps kilometres of ground round it, not the last zoom level.
  const metresPerPixel = Number(/1 px ≈ ([\d.]+) m/.exec(printed.caption)?.[1]);
  expect(metresPerPixel).toBeGreaterThanOrEqual(2);
});
