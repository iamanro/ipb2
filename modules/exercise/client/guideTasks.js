/**
 * The Exercise guide: what each kind of member does during an exercise, in
 * order, as tasks that open the right tab. Pure (no DOM): `guide.js` renders
 * it, the tests read it.
 *
 * `done(progress)` reads what the member can see (`progress`: the lists the
 * tab views load); `ongoing` tasks have no end (following the activity).
 */

import { buildMatrixRows, findUncoveredSirs } from './syncMatrix.js';

const hasEvidence = (requirement) =>
  requirement.links.length > 0 || requirement.sirs.some((sir) => sir.links?.length > 0);

const TASKS = {
  geography: {
    title: 'Scenario geography',
    tab: 'geography',
    why: 'Pick or build the exercise scenario: its countries and renamed places, used by the maps and reports.',
    done: (p) => Boolean(p.activeScenario),
  },
  instructor: {
    title: 'Story & situations',
    tab: 'instructor',
    why: 'Prepare the private story, build situations, and decide when Blue receives each report or message.',
    ongoing: true,
  },
  briefing: {
    title: 'Read your briefing',
    tab: 'scenario',
    why: 'Your mission and updates released by the instructors. Only delivered messages appear here.',
    ongoing: true,
  },
  'answer-rfis': {
    title: 'Answer RFIs',
    tab: 'rfi',
    why: 'Requests for information from the cells wait here for White to assign, answer or reject.',
    done: (p) =>
      !p.rfis.some((rfi) =>
        ['submitted', 'assigned', 'in_collection', 'reopened'].includes(rfi.state),
      ),
  },
  activity: {
    title: 'Follow the exercise',
    tab: 'activity',
    why: 'Who did what, in scenario order: for steering the exercise and the after-action review.',
    ongoing: true,
  },
  requirements: {
    title: 'Requirements from your IPB',
    tab: 'requirements',
    why: 'Import your study’s event matrix: it becomes PIRs, SIRs and indicators on your NAIs.',
    done: (p) => p.requirements.length > 0,
  },
  collectors: {
    title: 'Collectors',
    tab: 'collection',
    why: 'The sensors and units you can task: discipline, range and when they are available.',
    done: (p) => p.collectors.length > 0,
  },
  taskings: {
    title: 'Task collectors',
    tab: 'collection',
    why: 'Put a collector on each SIR at its NAI for a time window. Each tasking gets its SOR text.',
    done: (p) => p.taskings.length > 0,
  },
  gaps: {
    title: 'Close the gaps',
    tab: 'collection',
    why: 'In the synchronization matrix: SIRs no one covers, and collectors double-booked or tasked when unavailable.',
    done: (p) =>
      p.taskings.length > 0 &&
      p.conflicts.overlaps.length === 0 &&
      p.conflicts.outside.length === 0 &&
      findUncoveredSirs(buildMatrixRows(p.requirements, p.taskings, [])).length === 0,
  },
  reports: {
    title: 'Log reports',
    tab: 'reports',
    why: 'Every report that comes in: where, what, and how reliable. It links itself to the NAI it falls in.',
    done: (p) => p.reports.length > 0,
  },
  evidence: {
    title: 'Link reports as evidence',
    tab: 'reports',
    why: 'Mark which requirement a report confirms, denies or partly answers: requirements track how far they are answered.',
    done: (p) => p.requirements.some(hasEvidence),
  },
  situation: {
    title: 'Plot the situation',
    tab: 'situation',
    why: 'Turn located reports into tracks of enemy units on the situation map.',
    done: (p) => p.tracks.length > 0,
  },
  rfi: {
    title: 'Ask for information',
    tab: 'rfi',
    why: 'What you cannot find yourself, ask White for as an RFI.',
    done: (p) => p.rfis.length > 0,
  },
  intsum: {
    title: 'Write the INTSUM',
    tab: 'products',
    why: 'Draft it from the tracks, reports and requirements of the period, edit it, then save and print it.',
    done: (p) => p.intsums.length > 0,
  },
  'watch-situation': {
    title: 'Watch the situation',
    tab: 'situation',
    why: 'Tracks and located reports on the map, as your cell sees them.',
    ongoing: true,
  },
  'read-products': {
    title: 'Read the products',
    tab: 'products',
    why: 'The INTSUMs and graphic INTSUMs your cell has produced.',
    ongoing: true,
  },
};

/** Task lists by what a member does; `tabs` is what a list needs loaded. */
export const GUIDE_LISTS = {
  excon: {
    label: 'Exercise control',
    tasks: ['instructor', 'geography', 'answer-rfis', 'activity'],
  },
  analyst: {
    label: 'Analyst',
    tasks: ['briefing', 'requirements', 'reports', 'evidence', 'situation', 'rfi', 'intsum'],
  },
  collection: {
    label: 'Collection manager',
    tasks: [
      'briefing',
      'requirements',
      'collectors',
      'taskings',
      'gaps',
      'reports',
      'evidence',
      'situation',
      'intsum',
    ],
  },
  observer: {
    label: 'Observer',
    tasks: ['briefing', 'watch-situation', 'read-products'],
  },
};

/**
 * The list for a member: White's game-masters (and an admin acting as
 * White) run the exercise; otherwise by role.
 */
export function defaultList({ cell, role, admin }) {
  if ((cell === 'white' || admin) && (role === 'game-master' || (!role && admin))) return 'excon';
  if (role === 'game-master' || role === 'collection-manager') return 'collection';
  if (role === 'analyst') return 'analyst';
  return 'observer';
}

/** A list's tasks with their definitions, `[{ id, title, tab, why, done?, ongoing? }]`. */
export function listTasks(listId) {
  return GUIDE_LISTS[listId].tasks.map((id) => ({ id, ...TASKS[id] }));
}

/** `'done' | 'todo' | 'ongoing'` per task of the list, from what is loaded. */
export function taskStatuses(listId, progress) {
  return Object.fromEntries(
    listTasks(listId).map((task) => [
      task.id,
      task.ongoing ? 'ongoing' : task.done(progress) ? 'done' : 'todo',
    ]),
  );
}

/** The first task to do, else the first ongoing one. */
export function firstOpenTask(listId, statuses) {
  const tasks = listTasks(listId);
  return (
    tasks.find((task) => statuses[task.id] === 'todo')?.id ??
    tasks.find((task) => statuses[task.id] === 'ongoing')?.id ??
    null
  );
}

/** Which lists (collectors, …) a guide list needs fetched beyond the view's own. */
export function extraLoads(listId) {
  const needs = new Set();
  for (const task of listTasks(listId)) {
    if (task.id === 'situation') needs.add('tracks');
    if (task.id === 'intsum') needs.add('intsums');
    if (['collectors', 'taskings', 'gaps'].includes(task.id)) {
      needs.add('collectors');
      needs.add('taskings');
    }
    if (task.id === 'gaps') needs.add('conflicts');
    if (task.id === 'geography') needs.add('activeScenario');
  }
  return needs;
}
