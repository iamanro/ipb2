import { expect, test } from 'vitest';

import { buildZip } from './zipFixture.js';
import { readZipEntries } from './zip.ts';

test('reads a stored (uncompressed) entry', () => {
  const zip = buildZip([{ name: 'a.txt', data: Buffer.from('hello world'), method: 0 }]);
  const [entry] = readZipEntries(zip);
  expect(entry.name).toBe('a.txt');
  expect(entry.data.toString('utf8')).toBe('hello world');
});

test('reads a deflated entry', () => {
  const payload = Buffer.from('x'.repeat(5000));
  const zip = buildZip([{ name: 'sheet.tif', data: payload, method: 8 }]);
  const [entry] = readZipEntries(zip);
  expect(entry.name).toBe('sheet.tif');
  expect(entry.data.equals(payload)).toBe(true);
});

test('reads multiple entries in order, mixed methods', () => {
  const world = Buffer.from('5.0\n0.0\n0.0\n-5.0\n302002.5\n5551997.5\n');
  const tif = Buffer.from('II*\x00fake-tiff-bytes'.repeat(50));
  const zip = buildZip([
    { name: 'sheet.tfw', data: world, method: 0 },
    { name: 'sheet.tif', data: tif, method: 8 },
  ]);
  const entries = readZipEntries(zip);
  expect(entries.map((entry) => entry.name)).toEqual(['sheet.tfw', 'sheet.tif']);
  expect(entries[0].data.equals(world)).toBe(true);
  expect(entries[1].data.equals(tif)).toBe(true);
});

test('a real ČÚZK DMR4G sheet archive extracts its .tif entry', () => {
  // Regression fixture: a genuine sheet zip has a .tfw (STORE) and a .tif
  // (DEFLATE) member; construct the same shape at a size worth compressing.
  const world = Buffer.from(
    '5.0000000000\n0.0000000000\n0.0000000000\n-5.0000000000\n302002.5000000000\n5551997.5000000000\n',
  );
  const heights = Buffer.alloc(400 * 400 * 4);
  for (let i = 0; i < heights.length; i += 4) heights.writeFloatLE(450 + Math.sin(i) * 10, i);
  const zip = buildZip([
    { name: '302_5550.tfw', data: world, method: 0 },
    { name: '302_5550.tif', data: heights, method: 8 },
  ]);
  const entries = readZipEntries(zip);
  const tif = entries.find((entry) => entry.name.endsWith('.tif'));
  expect(tif.data.length).toBe(heights.length);
  expect(tif.data.equals(heights)).toBe(true);
});

test('throws on truncated input with no end-of-central-directory record', () => {
  expect(() => readZipEntries(Buffer.from('not a zip'))).toThrow(/end-of-central-directory/);
});
