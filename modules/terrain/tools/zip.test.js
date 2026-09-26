import zlib from 'node:zlib';

import { expect, test } from 'vitest';

import { readZipEntries } from './zip.mjs';

/**
 * A tiny, valid, single-disk zip with no comment: local headers, then the
 * central directory, then the end record. CRC-32 is left as 0 (this reader
 * does not check it, matching the real DMR4G archives being trusted as-is).
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, method } of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14); // crc-32 (unchecked)
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16); // crc-32
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }
  const centralStart = offset;
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

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
