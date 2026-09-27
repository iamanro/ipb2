import { describe, expect, test } from 'vitest';

import { defaultList, firstOpenTask, taskStatuses } from './guideTasks.js';

const empty = () => ({
  requirements: [],
  reports: [],
  rfis: [],
  tracks: [],
  intsums: [],
  collectors: [],
  taskings: [],
  conflicts: { overlaps: [], outside: [] },
  activeScenario: null,
});

describe('defaultList', () => {
  test('White game-masters and admins acting as White run the exercise; others by role', () => {
    expect(defaultList({ cell: 'white', role: 'game-master' })).toBe('excon');
    expect(defaultList({ cell: null, role: null, admin: true })).toBe('excon');
    expect(defaultList({ cell: 'blue', role: 'game-master' })).toBe('collection');
    expect(defaultList({ cell: 'red', role: 'collection-manager' })).toBe('collection');
    expect(defaultList({ cell: 'blue', role: 'analyst' })).toBe('analyst');
    expect(defaultList({ cell: 'white', role: 'analyst' })).toBe('analyst');
    expect(defaultList({ cell: 'blue', role: 'observer' })).toBe('observer');
  });
});

describe('taskStatuses', () => {
  test('an analyst’s tasks tick from what the cell has done', () => {
    const progress = empty();
    expect(firstOpenTask('analyst', taskStatuses('analyst', progress))).toBe('requirements');
    progress.requirements.push({ links: [], sirs: [{ links: [] }] });
    progress.reports.push({});
    let statuses = taskStatuses('analyst', progress);
    expect(statuses).toMatchObject({ requirements: 'done', reports: 'done', evidence: 'todo' });
    expect(firstOpenTask('analyst', statuses)).toBe('evidence');
    // A link on a SIR counts as evidence too.
    progress.requirements[0].sirs[0].links.push({});
    statuses = taskStatuses('analyst', progress);
    expect(statuses.evidence).toBe('done');
  });

  test('exercise control: RFIs are done while none waits; following the activity never ends', () => {
    const progress = empty();
    progress.activeScenario = { id: 1 };
    progress.rfis.push({ state: 'answered' });
    let statuses = taskStatuses('excon', progress);
    expect(statuses['answer-rfis']).toBe('done');
    expect(statuses.activity).toBe('ongoing');
    const pending = { state: 'submitted' };
    progress.rfis.push(pending);
    for (const state of ['submitted', 'assigned', 'in_collection', 'reopened']) {
      pending.state = state;
      statuses = taskStatuses('excon', progress);
      expect(firstOpenTask('excon', statuses)).toBe('answer-rfis');
    }
  });

  test('collection gaps close only once there are taskings and no conflicts', () => {
    const progress = empty();
    expect(taskStatuses('collection', progress).gaps).toBe('todo');
    progress.requirements.push({
      id: 1,
      sirs: [{ id: 2 }],
      links: [],
      ltiov: '2026-09-27T12:00:00Z',
    });
    progress.taskings.push({ sir_id: 3, end_at: '2026-09-27T11:00:00Z' });
    expect(taskStatuses('collection', progress).gaps).toBe('todo');
    progress.taskings[0].sir_id = 2;
    progress.conflicts.overlaps.push({});
    expect(taskStatuses('collection', progress).gaps).toBe('todo');
    progress.conflicts.overlaps.length = 0;
    expect(taskStatuses('collection', progress).gaps).toBe('done');
    progress.taskings[0].end_at = '2026-09-27T13:00:00Z';
    expect(taskStatuses('collection', progress).gaps).toBe('todo');
  });
});
