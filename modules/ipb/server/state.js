// IPB studies: part of the exercise.
// Imports nothing else of the module: backup and restore load this without route code.
import path from 'node:path';

import { declareStateDatabase } from '../../../server/stateDatabase.js';

export default declareStateDatabase({
  id: 'ipb',
  file: 'ipb.db',
  exercise: true,
  defaultDir: path.join(import.meta.dirname, '..', 'state'),
});
