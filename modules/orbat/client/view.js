import './styles.css';
import { mountBuilder } from './builderView.js';
import { createElement } from './dom.js';
import { mountSymbols } from './symbolsView.js';
import template from './view.html?raw';

const VIEWS = { symbols: mountSymbols, builder: mountBuilder };
const DEFAULT_VIEW = 'builder';

/**
 * The URL is `/orbat/?view=<symbols|builder>&…`; each view owns the other
 * parameters and reads/writes them through `params`.
 */
function readParams() {
  return new URLSearchParams(window.location.search);
}

function writeParams(changes) {
  const params = readParams();
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === '') params.delete(key);
    else params.set(key, String(value));
  }
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}

function askConfirm(dialog, message, acceptLabel = 'Delete') {
  dialog.querySelector('#confirm-message').textContent = message;
  dialog.querySelector('.dialog-accept').textContent = acceptLabel;
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'accept'), {
      once: true,
    });
    dialog.returnValue = '';
    dialog.showModal();
  });
}

export function mount({ root, status }) {
  root.innerHTML = template;
  const tabs = [...root.querySelectorAll('.view-tab')];
  const viewRoot = root.querySelector('#view-root');
  const dialog = root.querySelector('#confirm-dialog');
  const statusText = createElement('span', 'source-status', 'APP-6(D) · offline');
  status.replaceChildren(statusText);

  let active = null;
  let unmountView = null;

  const context = {
    params: { read: readParams, write: writeParams },
    confirm: (message, acceptLabel) => askConfirm(dialog, message, acceptLabel),
    /** Switch views, e.g. from a symbol in the reference to the builder. */
    show: (view, params = {}) => show(view, params),
  };

  function activate(view) {
    active = view;
    for (const tab of tabs) {
      const selected = tab.dataset.view === view;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    viewRoot.setAttribute('aria-labelledby', `tab-${view}`);
    viewRoot.dataset.view = view;
    viewRoot.replaceChildren();
    viewRoot.scrollTop = 0;
    unmountView = VIEWS[view]({ root: viewRoot, ...context });
  }

  /** Mount `view` with only `params` in the URL: parameters belong to the view that wrote them. */
  function show(view, params = {}) {
    if (!VIEWS[view]) view = DEFAULT_VIEW;
    if (view === active) return;
    unmountView?.();
    unmountView = null;
    window.history.replaceState(null, '', `${window.location.pathname}?view=${view}`);
    writeParams(params);
    activate(view);
  }

  const onTabClick = (event) => {
    const tab = event.target.closest('.view-tab');
    if (tab) show(tab.dataset.view);
  };
  // Tablist keys: arrows move between tabs, activation follows focus.
  const onTabKey = (event) => {
    const index = tabs.indexOf(event.target);
    if (index < 0) return;
    let next = null;
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === 'Home') next = tabs[0];
    else if (event.key === 'End') next = tabs.at(-1);
    if (!next) return;
    event.preventDefault();
    next.focus();
    show(next.dataset.view);
  };
  const tablist = root.querySelector('.view-switch');
  tablist.addEventListener('click', onTabClick);
  tablist.addEventListener('keydown', onTabKey);

  const requested = readParams().get('view');
  // A link to a view keeps that view's own parameters (one ORBAT and unit).
  if (VIEWS[requested]) activate(requested);
  else show(DEFAULT_VIEW);

  return () => {
    unmountView?.();
    unmountView = null;
    if (dialog.open) dialog.close();
  };
}
