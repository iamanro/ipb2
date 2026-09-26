import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Remove the run's throwaway state, but only the temp dirs we made. */
export default function teardown() {
  for (const root of [process.env.IPB_STATE_ROOT, process.env.IPB_E2E_AUTH_STATE_ROOT]) {
    if (root && path.basename(root).startsWith('ipb-e2e-') && root.startsWith(os.tmpdir())) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
