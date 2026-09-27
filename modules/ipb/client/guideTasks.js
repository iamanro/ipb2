/**
 * The IPB guide: the four IPB steps broken into tasks, in the order a staff
 * works them, each with the one-line "what and why" the tools panel shows
 * and when it counts as done. Pure (no DOM): `guide.js` renders it and the
 * tests read it.
 *
 * `done(payload)` reads the study payload (`GET studies/:id`). A task with
 * no data behind it (review tasks) has no `done`: the cell ticks it by hand,
 * stored in `study.checked`, which also lets them skip a task that does not
 * apply.
 */

const byLayer = (payload, layer) => payload.features.some((feature) => feature.layer === layer);
const hasAnalysis = (payload, ...kinds) =>
  payload.analyses.some((analysis) => kinds.includes(analysis.kind));

export const GUIDE_STEPS = [
  {
    step: 1,
    title: 'Define the operational environment',
    tasks: [
      {
        id: 'ao',
        title: 'Area of operations',
        why: 'The ground your unit is responsible for. Draw it on the map or enter its corners from the order.',
        done: (payload) => Boolean(payload.study.ao),
      },
      {
        id: 'aoi',
        title: 'Area of interest',
        why: 'The wider area from which the enemy and the terrain can affect the AO: the extent of the whole analysis.',
        done: (payload) => Boolean(payload.study.aoi),
      },
      {
        id: 'weather',
        title: 'Light and weather',
        why: 'Read the light data and the forecast in the worksheet. Move the weather point if the area centre is not typical ground.',
      },
      {
        id: 'marking',
        title: 'Marking and notes',
        why: 'Set the classification marking printed on every page, and note what matters about the environment.',
        done: (payload) => Boolean(payload.study.notes?.step1?.trim()),
      },
    ],
  },
  {
    step: 2,
    title: 'Describe the environmental effects',
    tasks: [
      {
        id: 'mcoo',
        title: 'Mobility (MCOO)',
        why: 'Where vehicles can go, go slowly, or not at all. Run it once the AOI is set.',
        done: (payload) => hasAnalysis(payload, 'mobility'),
      },
      {
        id: 'obstacles',
        title: 'Obstacles',
        why: 'Rivers, built-up areas, minefields and anything else the MCOO does not show.',
        done: (payload) => byLayer(payload, 'obstacle'),
      },
      {
        id: 'key-terrain',
        title: 'Key terrain',
        why: 'Ground whose control gives a marked advantage. Start from the suggested summits.',
        done: (payload) => byLayer(payload, 'key-terrain'),
      },
      {
        id: 'avenues',
        title: 'Avenues of approach',
        why: 'The routes an enemy force can use to reach its objective, wide enough for its size.',
        done: (payload) => byLayer(payload, 'avenue'),
      },
      {
        id: 'observation',
        title: 'Observation and fields of fire',
        why: 'What can be seen from where: viewsheds from likely observation posts, line of sight between two points.',
        done: (payload) => hasAnalysis(payload, 'viewshed', 'line-of-sight'),
      },
      {
        id: 'civil',
        title: 'Civil considerations',
        why: 'Areas, structures, capabilities, organizations, people and events (ASCOPE) across PMESII-PT, in the worksheet.',
        done: (payload) => payload.civil_considerations.length > 0,
      },
    ],
  },
  {
    step: 3,
    title: 'Evaluate the threat',
    tasks: [
      {
        id: 'threats',
        title: 'Threat units',
        why: 'The enemy forces that can act in the AOI: type them in, or take them from an ORBAT.',
        done: (payload) => payload.threats.length > 0,
      },
      {
        id: 'targets',
        title: 'Symbols and targets',
        why: 'Check each threat’s symbol, and mark its high-value and high-payoff targets in the worksheet table.',
        done: (payload) => payload.threats.some((threat) => threat.hvt || threat.hpt),
      },
      {
        id: 'weapons',
        title: 'Weapon ranges',
        why: 'Look up the threat’s equipment and draw its weapon ranges as rings (map toolbar → Rings).',
        done: (payload) => byLayer(payload, 'range-ring'),
      },
    ],
  },
  {
    step: 4,
    title: 'Determine threat courses of action',
    tasks: [
      {
        id: 'coas',
        title: 'Courses of action',
        why: 'At least the most likely and the most dangerous enemy course of action.',
        done: (payload) =>
          ['most-likely', 'most-dangerous'].every((kind) =>
            payload.coas.some((coa) => coa.kind === kind),
          ),
      },
      {
        id: 'sitemp',
        title: 'Situation template',
        why: 'For each COA, select it in the worksheet and place its units and graphics on the map.',
        done: (payload) => byLayer(payload, 'unit'),
      },
      {
        id: 'nais',
        title: 'NAIs and TAIs',
        why: 'Where to look to confirm or deny each COA, and where to engage.',
        done: (payload) => byLayer(payload, 'nai'),
      },
      {
        id: 'events',
        title: 'Event template and matrix',
        why: 'Set H-hour, then what should be seen at each NAI, and when, for each COA.',
        done: (payload) => payload.events.length > 0,
      },
      {
        id: 'decisions',
        title: 'Decision points',
        why: 'Where and when the commander must decide, tied to an NAI or TAI and a time window.',
        done: (payload) => payload.decision_points.length > 0,
      },
      {
        id: 'handoff',
        title: 'Hand over to collection',
        why: 'In Exercise → Requirements, import this study: its events become PIRs, SIRs and indicators on its NAIs.',
      },
    ],
  },
];

export const GUIDE_TASK_IDS = GUIDE_STEPS.flatMap(({ tasks }) => tasks.map((task) => task.id));

/**
 * Each task's status for `payload`: `'done'` (its data is there), `'checked'`
 * (ticked by hand) or `'todo'`, keyed by task id.
 */
export function taskStatuses(payload) {
  const checked = new Set(payload.study.checked ?? []);
  const statuses = {};
  for (const { tasks } of GUIDE_STEPS) {
    for (const task of tasks) {
      if (task.done?.(payload)) statuses[task.id] = 'done';
      else statuses[task.id] = checked.has(task.id) ? 'checked' : 'todo';
    }
  }
  return statuses;
}

/** `{ done, total }` for one step. */
export function stepProgress(step, statuses) {
  const { tasks } = GUIDE_STEPS.find((entry) => entry.step === step);
  return { done: tasks.filter((task) => statuses[task.id] !== 'todo').length, total: tasks.length };
}

/** The first task of `step` still to do, or null when the step is complete. */
export function firstOpenTask(step, statuses) {
  const { tasks } = GUIDE_STEPS.find((entry) => entry.step === step);
  return tasks.find((task) => statuses[task.id] === 'todo')?.id ?? null;
}

/** The task after `taskId` in the whole guide, `{ step, id }`, or null after the last. */
export function taskAfter(taskId) {
  const all = GUIDE_STEPS.flatMap(({ step, tasks }) =>
    tasks.map((task) => ({ step, id: task.id })),
  );
  const index = all.findIndex((entry) => entry.id === taskId);
  return index >= 0 ? (all[index + 1] ?? null) : null;
}
