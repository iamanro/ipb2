import { describe, expect, test } from 'vitest';

import {
  GUIDE_TASK_IDS,
  firstOpenTask,
  stepProgress,
  taskAfter,
  taskStatuses,
} from './guideTasks.js';

const empty = () => ({
  study: { ao: null, aoi: null, notes: {}, checked: [] },
  features: [],
  threats: [],
  coas: [],
  events: [],
  analyses: [],
  decision_points: [],
  civil_considerations: [],
});

describe('taskStatuses', () => {
  test('a new study: everything to do, and every id is a valid checked slug', () => {
    const statuses = taskStatuses(empty());
    expect(Object.values(statuses).every((status) => status === 'todo')).toBe(true);
    expect(new Set(GUIDE_TASK_IDS).size).toBe(GUIDE_TASK_IDS.length);
    expect(GUIDE_TASK_IDS.every((id) => /^[a-z0-9-]{1,40}$/.test(id))).toBe(true);
  });

  test('data ticks tasks off; a hand tick counts too but never hides data', () => {
    const payload = empty();
    payload.study.ao = { type: 'Polygon', coordinates: [] };
    payload.study.checked = ['weather', 'aoi'];
    payload.features.push({ layer: 'unit' });
    payload.coas.push({ kind: 'most-likely' });
    const statuses = taskStatuses(payload);
    expect(statuses).toMatchObject({
      ao: 'done',
      aoi: 'checked',
      weather: 'checked',
      sitemp: 'done',
      // One of the two COA kinds is not enough.
      coas: 'todo',
    });
  });

  test('notes count only when they say something; targets need an HVT or HPT', () => {
    const payload = empty();
    payload.study.notes = { step1: '   ' };
    payload.threats.push({ hvt: false, hpt: false });
    expect(taskStatuses(payload)).toMatchObject({
      marking: 'todo',
      threats: 'done',
      targets: 'todo',
    });
    payload.threats.push({ hvt: false, hpt: true });
    expect(taskStatuses(payload).targets).toBe('done');
  });
});

describe('progress and order', () => {
  test('step progress and the first open task follow the statuses', () => {
    const payload = empty();
    payload.study.ao = {};
    payload.study.checked = ['weather'];
    const statuses = taskStatuses(payload);
    expect(stepProgress(1, statuses)).toEqual({ done: 2, total: 4 });
    expect(firstOpenTask(1, statuses)).toBe('aoi');
    payload.study.aoi = {};
    payload.study.notes = { step1: 'Wooded ridges' };
    expect(firstOpenTask(1, taskStatuses(payload))).toBeNull();
  });

  test('the task after the last of a step is the first of the next; none after the last', () => {
    expect(taskAfter('ao')).toEqual({ step: 1, id: 'aoi' });
    expect(taskAfter('marking')).toEqual({ step: 2, id: 'mcoo' });
    expect(taskAfter('handoff')).toBeNull();
    expect(taskAfter('nope')).toBeNull();
  });
});
