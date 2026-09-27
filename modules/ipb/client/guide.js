/**
 * The tools panel as a guide (`guideTasks.js`): the current IPB step's tasks
 * as a numbered checklist, only one open at a time with its "what and why",
 * its own controls and a Next button; rare tools folded into "More tools".
 * Statuses update in place (`refreshGuide`) as the study changes, so typing
 * in a task never loses focus to a re-render.
 */
import './guide.css';

import { GUIDE_STEPS, stepProgress, taskAfter, taskStatuses } from './guideTasks.js';

const MARKS = { done: '✓', checked: '✓', todo: '' };
const STATUS_TEXT = { done: 'done', checked: 'marked done', todo: 'to do' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function taskLabel(step, index) {
  return `${step}.${index + 1}`;
}

function findTask(id) {
  for (const { step, title, tasks } of GUIDE_STEPS) {
    const index = tasks.findIndex((task) => task.id === id);
    if (index >= 0) return { step, stepTitle: title, index, task: tasks[index] };
  }
  return null;
}

/** "Next: 1.2 Area of interest" or "Continue to step 2: Describe the environmental effects". */
function nextLabel(taskId) {
  const next = taskAfter(taskId);
  if (!next) return null;
  const found = findTask(next.id);
  const current = findTask(taskId);
  return found.step === current.step
    ? `Next: ${taskLabel(found.step, found.index)} ${found.task.title}`
    : `Continue to step ${found.step}: ${found.stepTitle}`;
}

/**
 * The guide for `step`. `openTaskId` is the one task shown open (null: all
 * folded). `bodies[taskId]()` builds a task's controls; `more()` the "More
 * tools" content. Callbacks: `onOpen(taskId | null)`, `onNext(taskId)`,
 * `onCheck(taskId, checked)`; `moreOpen`/`onMoreToggle(open)` keep "More
 * tools" folded or not across re-renders. `canEdit` hides Mark done.
 */
export function renderGuide({
  payload,
  step,
  openTaskId,
  bodies,
  more,
  moreOpen,
  canEdit,
  onOpen,
  onNext,
  onCheck,
  onMoreToggle,
}) {
  const { title, tasks } = GUIDE_STEPS.find((entry) => entry.step === step);
  const root = element('div', 'guide');
  root.dataset.step = String(step);

  const header = element('header', 'guide-header');
  header.append(element('p', 'eyebrow', `Step ${step} of ${GUIDE_STEPS.length}`));
  header.append(element('h2', 'guide-step-title', title));
  const progress = element('p', 'guide-progress');
  progress.setAttribute('aria-live', 'polite');
  const bar = element('div', 'guide-bar');
  bar.setAttribute('aria-hidden', 'true');
  bar.append(element('span'));
  header.append(progress, bar);
  root.append(header);

  const list = element('ol', 'guide-tasks');
  tasks.forEach((task, index) => {
    const item = element('li', 'guide-task');
    item.dataset.task = task.id;
    const open = task.id === openTaskId;
    const head = element('button', 'guide-task-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    const bodyId = `guide-body-${task.id}`;
    head.setAttribute('aria-controls', bodyId);
    head.append(
      element('span', 'guide-mark'),
      element('span', 'guide-number', taskLabel(step, index)),
      element('span', 'guide-title', task.title),
      element('span', 'visually-hidden guide-status-text'),
    );
    head.querySelector('.guide-mark').setAttribute('aria-hidden', 'true');
    head.addEventListener('click', () => onOpen(open ? null : task.id));
    item.append(head);

    if (open) {
      const body = element('div', 'guide-task-body');
      body.id = bodyId;
      body.append(element('p', 'guide-why', task.why));
      const controls = bodies[task.id]?.();
      if (controls) body.append(controls);
      const actions = element('div', 'guide-task-actions');
      if (canEdit) {
        const check = element('button', 'text-button guide-check');
        check.type = 'button';
        check.addEventListener('click', () => onCheck(task.id, check.dataset.checked !== 'true'));
        actions.append(check);
      }
      const label = nextLabel(task.id);
      if (label) {
        const next = element('button', 'primary-button guide-next', `${label} →`);
        next.type = 'button';
        next.addEventListener('click', () => onNext(task.id));
        actions.append(next);
      } else {
        actions.append(
          element(
            'p',
            'guide-finished',
            'That is the whole IPB. Keep the study up to date as reports come in.',
          ),
        );
      }
      body.append(actions);
      item.append(body);
    }
    list.append(item);
  });
  root.append(list);

  const moreBox = element('details', 'guide-more');
  moreBox.open = moreOpen;
  moreBox.append(element('summary', null, 'More tools'));
  moreBox.addEventListener('toggle', () => onMoreToggle(moreBox.open));
  const moreBody = element('div', 'guide-more-body');
  moreBody.append(...more());
  moreBox.append(moreBody);
  root.append(moreBox);

  refreshGuide(root, payload, { canEdit });
  return root;
}

/**
 * Brings a rendered guide's marks, progress and Mark done button up to date
 * with `payload`, without rebuilding any task's controls.
 */
export function refreshGuide(root, payload, { canEdit }) {
  const step = Number(root.dataset.step);
  const statuses = taskStatuses(payload);
  const { done, total } = stepProgress(step, statuses);
  root.querySelector('.guide-progress').textContent =
    done === total ? `All ${total} tasks done` : `${done} of ${total} tasks done`;
  root.querySelector('.guide-bar span').style.width = `${(done / total) * 100}%`;
  root.classList.toggle('guide-complete', done === total);
  for (const item of root.querySelectorAll('.guide-task')) {
    const status = statuses[item.dataset.task];
    item.dataset.status = status;
    item.querySelector('.guide-mark').textContent = MARKS[status];
    item.querySelector('.guide-status-text').textContent = `, ${STATUS_TEXT[status]}`;
    // Until a task is done its own controls are the main action, not Next.
    const next = item.querySelector('.guide-next');
    next?.classList.toggle('primary-button', status !== 'todo');
    next?.classList.toggle('chip-button', status === 'todo');
    const check = item.querySelector('.guide-check');
    if (!check) continue;
    // Done by its data: nothing to tick. Otherwise tick or untick by hand.
    check.hidden = status === 'done' || !canEdit;
    check.dataset.checked = String(status === 'checked');
    check.textContent = status === 'checked' ? 'Mark not done' : 'Mark done / skip';
  }
}
