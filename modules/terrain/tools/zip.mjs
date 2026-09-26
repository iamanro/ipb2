import zlib from 'node:zlib';

/**
 * Minimal ZIP reader: just enough to pull named entries out of the small
 * (tens of KB) single-directory archives ČÚZK ships each DMR4G sheet in
 * (one `.tif`, one `.tfw`, STORE or DEFLATE, no zip64, no encryption). Node
 * has no built-in unzip; this avoids a dependency for two record types.
 *
 * Reads the central directory (authoritative for sizes/offsets, unlike the
 * local header when the streaming bit is set) then decompresses each entry
 * named there. Throws on anything that isn't a plain, complete local zip.
 */
export function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Bad central directory entry at byte ${offset}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries.map(({ name, method, compressedSize, uncompressedSize, localHeaderOffset }) => {
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Bad local header for ${name} at byte ${localHeaderOffset}`);
    }
    const nameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + nameLength + extraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw new Error(`${name}: unsupported zip compression method ${method}`);
    if (data.length !== uncompressedSize) {
      throw new Error(
        `${name}: decompressed to ${data.length} bytes, expected ${uncompressedSize}`,
      );
    }
    return { name, data };
  });
}

/** Scans backward for the end-of-central-directory record (with no comment, it's the last 22 bytes). */
function findEndOfCentralDirectory(buffer) {
  const maxBack = Math.min(buffer.length, 65557); // EOCD size plus the largest possible comment
  for (
    let position = buffer.length - 22;
    position >= buffer.length - maxBack && position >= 0;
    position -= 1
  ) {
    if (buffer.readUInt32LE(position) === 0x06054b50) return position;
  }
  throw new Error('Not a zip file (no end-of-central-directory record found)');
}
