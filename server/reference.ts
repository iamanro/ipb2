import { statSync } from 'node:fs';

/**
 * A read-only reference file (`modules/<id>/data/*`), opened on first use and
 * reopened whenever the file on disk changes. Build tools either replace their
 * output (new inode) or add to it in place (new mtime); a handle kept past
 * either would serve the old data until a full server restart.
 *
 * `file` is usually one path, but can be an array when `open` needs more
 * than one file to build its handle (e.g. a base elevation model plus an
 * optional finer-detail one) — `get()` then reopens on a change to *any* of
 * them, and `open` receives the whole array instead of a single path. Only
 * the first path is required to exist; later ones are optional inputs that
 * `open` itself checks for, so a handle can still combine "detail file not
 * built yet" with "base file present" instead of reporting fully missing.
 *
 * `open(file)` (or `open(files)`) returns a handle with `close()`. `get()`
 * returns the current handle, or null while the first file does not exist;
 * errors from `open` propagate and the next `get()` tries again.
 */
export function referenceFile<F extends string | string[], H extends { close(): void }>(
  file: F,
  open: (file: F) => H,
): { get(): H | null; close(): void } {
  const paths: string[] = Array.isArray(file) ? file : [file];
  let handle: H | null = null;
  let identity: string | null = null;
  function close() {
    handle?.close();
    handle = null;
    identity = null;
  }
  return {
    get() {
      const stats = paths.map((path) => statSync(path, { throwIfNoEntry: false }));
      const current = stats[0]
        ? stats.map((s) => (s ? `${s.ino}:${s.mtimeMs}` : '')).join('|')
        : null;
      if (current !== identity) {
        close();
        if (current) handle = open(file);
        identity = current;
      }
      return handle;
    },
    close,
  };
}
