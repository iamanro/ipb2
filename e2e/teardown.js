import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Remove the run's throwaway state, but only if it is the temp dir we made. */
export default function teardown() {
  const root = process.env.IPB_STATE_ROOT;
  if (root && path.basename(root).startsWith('ipb-e2e-') && root.startsWith(os.tmpdir())) {
    rmSync(root, { recursive: true, force: true });
  }
}
