// Canvas work: print furniture (scale bar, north arrow) and grid rasters.

// -- Print furniture ---------------------------------------------------------------

/** Longest 1/2/5 × 10^n metres that fits in `maxMetres`. */
function niceScaleLength(maxMetres) {
  const power = 10 ** Math.floor(Math.log10(maxMetres));
  return [5, 2, 1].map((step) => step * power).find((length) => length <= maxMetres);
}

/** Four-segment black/white scale bar in the bottom-left corner (CSS px). */
export function drawScaleBar(context, height, metresPerPixel) {
  const metres = niceScaleLength(160 * metresPerPixel);
  const barWidth = metres / metresPerPixel;
  const x = 16;
  const y = height - 30;
  const label = metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
  context.font = '600 11px "Cascadia Mono", "IBM Plex Mono", ui-monospace, monospace';
  context.fillStyle = 'rgba(255, 255, 255, 0.9)';
  context.fillRect(x - 8, y - 20, barWidth + 16 + context.measureText(label).width + 8, 38);
  for (let segment = 0; segment < 4; segment += 1) {
    context.fillStyle = segment % 2 ? '#ffffff' : '#1b1b1b';
    context.fillRect(x + (segment * barWidth) / 4, y, barWidth / 4, 6);
  }
  context.strokeStyle = '#1b1b1b';
  context.lineWidth = 1;
  context.strokeRect(x, y, barWidth, 6);
  context.fillStyle = '#1b1b1b';
  context.textBaseline = 'bottom';
  context.fillText('0', x - 3, y - 3);
  context.fillText(label, x + barWidth + 6, y + 8);
}

/** North arrow in the top-right corner, only drawn when the view is rotated. */
export function drawNorthArrow(context, width, rotation) {
  context.save();
  context.translate(width - 30, 36);
  context.rotate(rotation);
  context.fillStyle = '#1b1b1b';
  context.beginPath();
  context.moveTo(0, -16);
  context.lineTo(7, 10);
  context.lineTo(0, 5);
  context.lineTo(-7, 10);
  context.closePath();
  context.fill();
  context.font = '700 11px system-ui, sans-serif';
  context.textAlign = 'center';
  context.fillText('N', 0, -20);
  context.restore();
}

// -- Grid overlay rasterisation ---------------------------------------------

function decodeGridValues(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function cssColorToRgba(css, probeContext) {
  probeContext.clearRect(0, 0, 1, 1);
  probeContext.fillStyle = css;
  probeContext.fillRect(0, 0, 1, 1);
  return probeContext.getImageData(0, 0, 1, 1).data;
}

export function buildGridCanvas(grid, palette) {
  const canvas = document.createElement('canvas');
  canvas.width = grid.width;
  canvas.height = grid.height;
  const context = canvas.getContext('2d');
  const imageData = context.createImageData(grid.width, grid.height);
  const values = decodeGridValues(grid.values);

  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  const probeContext = probe.getContext('2d');
  const colorCache = new Map();

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    const css = palette[value];
    const offset = i * 4;
    if (!css) {
      imageData.data[offset + 3] = 0;
      continue;
    }
    let rgba = colorCache.get(css);
    if (!rgba) {
      rgba = cssColorToRgba(css, probeContext);
      colorCache.set(css, rgba);
    }
    imageData.data[offset] = rgba[0];
    imageData.data[offset + 1] = rgba[1];
    imageData.data[offset + 2] = rgba[2];
    imageData.data[offset + 3] = rgba[3];
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

/** Paint a fixed-resolution raster canvas into the extent OL is requesting, nearest-neighbour. */
export function paintGridInto(sourceCanvas, sourceExtent, destExtent, destSize) {
  const canvas = document.createElement('canvas');
  canvas.width = destSize[0];
  canvas.height = destSize[1];
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;

  const [gx0, gy0, gx1, gy1] = sourceExtent;
  const [ex0, ey0, ex1, ey1] = destExtent;
  const gw = sourceCanvas.width;
  const gh = sourceCanvas.height;

  const scaleX = (destSize[0] * (gx1 - gx0)) / (gw * (ex1 - ex0));
  const scaleY = (destSize[1] * (gy1 - gy0)) / (gh * (ey1 - ey0));
  const offsetX = (destSize[0] * (gx0 - ex0)) / (ex1 - ex0);
  const offsetY = (destSize[1] * (ey1 - gy1)) / (ey1 - ey0);

  context.setTransform(scaleX, 0, 0, scaleY, offsetX, offsetY);
  context.drawImage(sourceCanvas, 0, 0);
  context.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}
