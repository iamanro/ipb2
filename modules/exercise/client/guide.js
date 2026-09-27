/**
 * The Exercise sidebar as a guide: the member's tasks (`guideTasks.js`) in
 * order, each opening the tab it happens in, ticked off from what the cell
 * has done; the full list of sections folds away under "All sections".
 */
import { GUIDE_LISTS, listTasks, taskStatuses } from './guideTasks.js';

const MARKS = { done: '✓', todo: '', ongoing: '•' };
const STATUS_TEXT = { done: 'done', todo: 'to do', ongoing: 'ongoing' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * `listId`/`lists`: the task list shown and, when the member may pick
 * (White, admins, the local operator), the lists offered. `progress` is null
 * while loading. Callbacks: `onOpen(taskId)` (open it and go to its tab),
 * `onList(listId)`.
 */
export function renderExerciseGuide({ listId, lists, progress, openTaskId, onOpen, onList }) {
  const root = element('section', 'guide');
  root.setAttribute('aria-label', 'Your tasks');
  const header = element('div', 'guide-header');
  header.append(element('p', 'eyebrow', 'Your tasks'));
  if (lists.length > 1) {
    const select = element('select', 'guide-list-select');
    select.setAttribute('aria-label', 'Show the tasks of');
    for (const id of lists) select.append(new Option(GUIDE_LISTS[id].label, id));
    select.value = listId;
    select.addEventListener('change', () => onList(select.value));
    header.append(select);
  } else {
    header.append(element('p', 'guide-list-label', GUIDE_LISTS[listId].label));
  }
  root.append(header);

  const tasks = listTasks(listId);
  if (!progress) {
    root.append(element('p', 'panel-note', 'Loading…'));
    return root;
  }
  const statuses = taskStatuses(listId, progress);
  const countable = tasks.filter((task) => !task.ongoing);
  const done = countable.filter((task) => statuses[task.id] === 'done').length;
  if (countable.length) {
    header.append(element('p', 'guide-progress', `${done} of ${countable.length} done`));
  }

  const list = element('ol', 'guide-tasks');
  tasks.forEach((task, index) => {
    const status = statuses[task.id];
    const open = task.id === openTaskId;
    const item = element('li', 'guide-task');
    item.dataset.task = task.id;
    item.dataset.status = status;
    const head = element('button', 'guide-task-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    const mark = element('span', 'guide-mark', MARKS[status]);
    mark.setAttribute('aria-hidden', 'true');
    head.append(
      mark,
      element('span', 'guide-number', String(index + 1)),
      element('span', 'guide-title', task.title),
      element('span', 'visually-hidden', `, ${STATUS_TEXT[status]}`),
    );
    head.addEventListener('click', () => onOpen(task.id));
    item.append(head);
    if (open) {
      const body = element('div', 'guide-task-body');
      body.append(element('p', 'guide-why', task.why));
      const next = tasks[index + 1];
      if (next) {
        const button = element(
          'button',
          status === 'todo' ? 'chip-button guide-next' : 'primary-button guide-next',
          `Next: ${next.title} →`,
        );
        button.type = 'button';
        button.addEventListener('click', () => onOpen(next.id));
        body.append(button);
      }
      item.append(body);
    }
    list.append(item);
  });
  root.append(list);
  return root;
}
