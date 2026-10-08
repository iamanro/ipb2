// Equipment bookmarks: shared by every cell, outlive any one exercise.
// Imports nothing else of the module: backup and restore load this without route code.
import path from 'node:path';

import { declareStateDatabase } from '../../../server/stateDatabase.ts';

export default declareStateDatabase({
  id: 'equipment',
  file: 'bookmarks.db',
  exercise: false,
  defaultDir: path.join(import.meta.dirname, '..', 'state'),
});
