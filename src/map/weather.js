// Online weather layers: WMS tiles, cloud tiles and wind arrows.

import { createXYZ } from 'ol/tilegrid.js';
import Style from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import Fill from 'ol/style/Fill.js';
import TextStyle from 'ol/style/Text.js';
import IconStyle from 'ol/style/Icon.js';
import { downwindRotation, wmsTileUrl } from '../weather.js';

// -- Weather ----------------------------------------------------------------

/** Cloud tint per basemap tone: dark shading on paper maps, white over imagery. */
export const CLOUD_TINT = {
  dark: { rgb: [38, 58, 88], alpha: 0.38 },
  light: { rgb: [255, 255, 255], alpha: 0.55 },
};

const WEATHER_TILE_SIZE = 256;
const WEATHER_TILE_GRID = createXYZ({ tileSize: WEATHER_TILE_SIZE });

/**
 * Deepest cloud-mask tile zoom. Meteosat's 3 km pixels are ~4-6 km at 50° N;
 * 32 px per zoom-8 tile (~4.9 km) is about that.
 */
export const CLOUD_MAX_ZOOM = 8;

/**
 * Cloud-mask request size for a tile zoom, at about the product's own pixel
 * size, so the browser does the enlarging smoothly instead of the server in
 * hard blocks. Each zoom out doubles the ground a tile covers, so it doubles
 * the pixels, up to the full tile.
 */
export function cloudRequestSize(z) {
  return Math.min(WEATHER_TILE_SIZE, 32 * 2 ** (CLOUD_MAX_ZOOM - z));
}

const WIND_INK = {
  dark: { stroke: '#123047', halo: 'rgba(255, 255, 255, 0.9)' },
  light: { stroke: '#ffffff', halo: 'rgba(0, 0, 0, 0.75)' },
};

const windArrowCache = new Map();

/** A north-pointing arrow, longer for stronger wind (capped at 20 m/s). */
function windArrowCanvas(length, tone) {
  const key = `${tone}:${length}`;
  let canvas = windArrowCache.get(key);
  if (canvas) return canvas;
  const ink = WIND_INK[tone];
  const ratio = window.devicePixelRatio || 1;
  const width = 14;
  canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * ratio);
  canvas.height = Math.ceil((length + 4) * ratio);
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  const shaft = () => {
    context.beginPath();
    context.moveTo(width / 2, length + 2);
    context.lineTo(width / 2, 4);
    context.moveTo(2, 10);
    context.lineTo(width / 2, 2);
    context.lineTo(width - 2, 10);
  };
  shaft();
  context.strokeStyle = ink.halo;
  context.lineWidth = 4.5;
  context.stroke();
  shaft();
  context.strokeStyle = ink.stroke;
  context.lineWidth = 2;
  context.stroke();
  windArrowCache.set(key, canvas);
  return canvas;
}

/** Arrow pointing downwind plus "speed (gusts)" in m/s. */
export function windStyle({ speed, gusts, direction }, tone) {
  if (!Number.isFinite(speed) || !Number.isFinite(direction)) return null;
  const length = Math.round(14 + Math.min(speed, 20) * 1.6);
  const ink = WIND_INK[tone];
  const ratio = window.devicePixelRatio || 1;
  // Not aviation "2G7": at label size the G reads as a 6.
  const gustText = Number.isFinite(gusts) && gusts >= speed + 3 ? ` (${Math.round(gusts)})` : '';
  return [
    new Style({
      image: new IconStyle({
        img: windArrowCanvas(length, tone),
        scale: 1 / ratio,
        rotation: downwindRotation(direction),
        rotateWithView: true,
      }),
    }),
    new Style({
      text: new TextStyle({
        text: `${Math.round(speed)}${gustText}`,
        font: '600 11px ui-monospace, SFMono-Regular, Menlo, monospace',
        fill: new Fill({ color: ink.stroke }),
        stroke: new Stroke({ color: ink.halo, width: 3 }),
        offsetY: 18,
      }),
    }),
  ];
}

/**
 * Load one WMS tile as a canvas; `transform(ImageData)` may recolour it. The
 * WMS answers with CORS `*`, so the pixels are readable. A coarse product can
 * be fetched at `size` < the tile size and upscaled smoothly here: the server
 * resamples nearest-neighbour, which draws its pixels as hard blocks.
 */
export async function loadWmsTile(layer, time, [z, x, y], signal, { size, transform } = {}) {
  const extent = WEATHER_TILE_GRID.getTileCoordExtent([z, x, y]);
  const requestSize = Math.min(size ?? WEATHER_TILE_SIZE, WEATHER_TILE_SIZE);
  const response = await fetch(wmsTileUrl(layer, extent, requestSize, time), { signal });
  if (!response.ok) throw new Error(`WMS ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  let canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: Boolean(transform) });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  if (transform) {
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    transform(image.data);
    context.putImageData(image, 0, 0);
  }
  if (canvas.width < WEATHER_TILE_SIZE) {
    const small = canvas;
    canvas = document.createElement('canvas');
    canvas.width = WEATHER_TILE_SIZE;
    canvas.height = WEATHER_TILE_SIZE;
    const large = canvas.getContext('2d');
    large.imageSmoothingQuality = 'high';
    large.drawImage(small, 0, 0, WEATHER_TILE_SIZE, WEATHER_TILE_SIZE);
  }
  return canvas;
}
