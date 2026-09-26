/**
 * `worker_threads` worker for build_dmr4g.mjs: given one downloaded sheet
 * archive, decodes its TIFF and resamples it onto the lon/lat grid cells its
 * footprint covers, bilinearly, in UTM pixel space. Runs on the pool the
 * main thread starts (default up to 32, one per sheet in flight at a time),
 * so a whole country's worth of sheets reprojects in parallel.
 */
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

import { fromArrayBuffer } from 'geotiff';

import { lonLatToUtm33, utm33ToLonLat } from './utm33.mjs';
import { readZipEntries } from './zip.mjs';

const { cellsPerDegree, tileSize } = workerData;

/** Bilinear sample in UTM pixel space (metres); NaN outside the raster or at nodata. */
function sampleUtm(raster, easting, northing) {
  const x = (easting - raster.west) / raster.stepX - 0.5;
  const y = (raster.north - northing) / raster.stepY - 0.5;
  if (x < -0.5 || y < -0.5 || x > raster.width - 0.5 || y > raster.height - 0.5) return NaN;
  const x0 = Math.min(Math.max(Math.floor(x), 0), raster.width - 1);
  const y0 = Math.min(Math.max(Math.floor(y), 0), raster.height - 1);
  const x1 = Math.min(x0 + 1, raster.width - 1);
  const y1 = Math.min(y0 + 1, raster.height - 1);
  const fx = Math.min(Math.max(x - x0, 0), 1);
  const fy = Math.min(Math.max(y - y0, 0), 1);
  const at = (column, row) => {
    const value = raster.values[row * raster.width + column];
    return raster.nodata !== null && value === raster.nodata ? NaN : value;
  };
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** UTM zone-33N bounding box of a `<E_km>_<N_km>` sheet name (metres, exact — see build_dmr4g.mjs). */
function sheetUtmBounds(name) {
  const [eastKm, northKm] = name.split('_').map(Number);
  const west = eastKm * 1000;
  const south = northKm * 1000;
  return { west, south, east: west + 2000, north: south + 2000 };
}

async function processSheet(name, zipFile) {
  const { west, south, east, north } = sheetUtmBounds(name);
  const buffer = readFileSync(zipFile);
  const entries = readZipEntries(buffer);
  const tifEntry = entries.find((entry) => entry.name.toLowerCase().endsWith('.tif'));
  if (!tifEntry) throw new Error(`${name}: no .tif entry in the archive`);
  const arrayBuffer = tifEntry.data.buffer.slice(
    tifEntry.data.byteOffset,
    tifEntry.data.byteOffset + tifEntry.data.byteLength,
  );
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const [values] = await image.readRasters();
  const raster = {
    west,
    south,
    east,
    north,
    width,
    height,
    stepX: (east - west) / width,
    stepY: (north - south) / height,
    values,
    nodata: image.getGDALNoData(),
  };

  // The lon/lat rectangle enclosing the (slightly rotated, by grid
  // convergence away from the central meridian) UTM square, plus a one-cell
  // margin so bilinear sampling never misses an edge cell.
  const corners = [
    utm33ToLonLat(west, south),
    utm33ToLonLat(east, south),
    utm33ToLonLat(west, north),
    utm33ToLonLat(east, north),
  ];
  const lons = corners.map(([lon]) => lon);
  const lats = corners.map(([, lat]) => lat);
  const margin = 2 / cellsPerDegree;
  const ixMin = Math.floor(Math.min(...lons) * cellsPerDegree - margin * cellsPerDegree);
  const ixMax = Math.ceil(Math.max(...lons) * cellsPerDegree + margin * cellsPerDegree);
  const iyMin = Math.floor(Math.min(...lats) * cellsPerDegree - margin * cellsPerDegree);
  const iyMax = Math.ceil(Math.max(...lats) * cellsPerDegree + margin * cellsPerDegree);

  const tiles = new Map();
  let filled = 0;
  for (let iy = iyMin; iy <= iyMax; iy += 1) {
    const lat = (iy + 0.5) / cellsPerDegree;
    for (let ix = ixMin; ix <= ixMax; ix += 1) {
      const lon = (ix + 0.5) / cellsPerDegree;
      const [easting, northing] = lonLatToUtm33(lon, lat);
      const value = sampleUtm(raster, easting, northing);
      if (Number.isNaN(value)) continue;
      const tx = Math.floor(ix / tileSize);
      const ty = Math.floor(iy / tileSize);
      const key = `${tx}/${ty}`;
      let entry = tiles.get(key);
      if (!entry) {
        entry = { tx, ty, grid: new Float32Array(tileSize * tileSize).fill(NaN) };
        tiles.set(key, entry);
      }
      entry.grid[(iy - ty * tileSize) * tileSize + (ix - tx * tileSize)] = value;
      filled += 1;
    }
  }
  return {
    lonLatBounds: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
    filled,
    tiles: [...tiles.values()],
  };
}

parentPort.on('message', async (message) => {
  if (message.type !== 'sheet') return;
  try {
    const { lonLatBounds, filled, tiles } = await processSheet(message.name, message.zipFile);
    parentPort.postMessage(
      {
        type: 'result',
        name: message.name,
        lonLatBounds,
        filled,
        tiles: tiles.map(({ tx, ty, grid }) => ({ tx, ty, buffer: grid.buffer })),
      },
      tiles.map(({ grid }) => grid.buffer),
    );
  } catch (error) {
    parentPort.postMessage({ type: 'error', name: message.name, message: error.message });
  }
});
parentPort.postMessage({ type: 'ready' });
