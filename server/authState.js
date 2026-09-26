// Accounts, sessions, memberships and the exercise record: outlive any one exercise.
import path from 'node:path';

import { declareStateDatabase } from './stateDatabase.js';

export default declareStateDatabase({
  id: 'auth',
  file: 'auth.db',
  exercise: false,
  defaultDir: path.join(import.meta.dirname, 'state'),
});
