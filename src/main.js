import './shell.css';

import { modules } from './modules.js';

const nav = document.querySelector('#module-nav');
const root = document.querySelector('#module-root');
const status = document.querySelector('#masthead-status');

const byId = new Map(modules.map((module) => [module.id, module]));
let active = null;
let unmount = null;
let routeToken = 0;

function modulePath(module) {
  return `/${module.id}/`;
}

function requestedModule() {
  const id = window.location.pathname.split('/')[1];
  return byId.get(id) || null;
}

function renderNav() {
  nav.replaceChildren(
    ...modules.map((module) => {
      const link = document.createElement('a');
      link.href = modulePath(module);
      link.title = module.summary;
      link.textContent = module.title;
      if (module === active) link.setAttribute('aria-current', 'page');
      return link;
    }),
  );
}

async function route() {
  let module = requestedModule();
  if (!module) {
    module = modules[0];
    window.history.replaceState(null, '', modulePath(module));
  }
  if (module === active) return;
  const token = ++routeToken;
  unmount?.();
  unmount = null;
  status.replaceChildren();
  root.replaceChildren();
  root.dataset.module = module.id;
  active = module;
  document.title = `${module.title} · IPB`;
  renderNav();
  try {
    const { mount } = await module.load();
    if (token !== routeToken) return;
    unmount = mount({ root, status });
  } catch (error) {
    if (token !== routeToken) return;
    const message = document.createElement('div');
    message.className = 'module-error';
    message.textContent = error.message;
    root.replaceChildren(message);
  }
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link || link.origin !== window.location.origin) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  const target = link.pathname === '/' ? modules[0] : byId.get(link.pathname.split('/')[1]);
  if (!target || link.pathname !== modulePath(target)) return;
  event.preventDefault();
  if (target === active) return;
  window.history.pushState(null, '', link.href);
  route();
});
window.addEventListener('popstate', route);

route();
