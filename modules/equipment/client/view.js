import './styles.css';
import template from './view.html?raw';

const API = '/api/equipment';
const PAGE_SIZE = 100;
const KINDS = ['domain', 'origin', 'proliferation'];
const KIND_LABELS = {
  domain: 'Category',
  origin: 'Country of origin',
  proliferation: 'Used by country',
};
const QUICK_FILTER_THRESHOLD = 20;

let state;
let elements;

function createState() {
  return {
    cards: [],
    total: 0,
    query: '',
    filters: { domain: new Set(), origin: new Set(), proliferation: new Set() },
    taxonomy: { domain: new Map(), origin: new Map(), proliferation: new Map() },
    nodesById: { domain: new Map(), origin: new Map(), proliferation: new Map() },
    selectedId: null,
    requestedId: null,
    request: null,
    session: new AbortController(),
  };
}

function queryElements(root) {
  const pick = (selector) => root.querySelector(selector);
  return {
    cardList: pick('#card-list'),
    resultCount: pick('#result-count'),
    resultStatus: pick('#result-status'),
    resultOrder: pick('#result-order'),
    activeFilters: pick('#active-filters'),
    filterGroups: pick('#filter-groups'),
    clearFilters: pick('#clear-filters'),
    search: pick('#equipment-search'),
    detail: pick('#card-detail'),
    detailEmpty: pick('#detail-empty'),
    detailPanel: pick('#detail-panel'),
    loadMore: pick('#load-more'),
  };
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDate(value) {
  if (!value) return 'Unknown';
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(
        date,
      );
}

function foldText(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isoLabel(entry) {
  return /^[a-z]{2}$/.test(entry.iso_code || '') ? entry.iso_code.toUpperCase() : null;
}

/** Every request dies with its mount, so a stale view never touches a newer one. */
async function requestJson(path, signal = state.session.signal) {
  const response = await fetch(path, { signal });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload;
}

// --- URL state -----------------------------------------------------------

function readLocation() {
  const parameters = new URLSearchParams(window.location.search);
  state.query = parameters.get('q') || '';
  KINDS.forEach((kind) => {
    state.filters[kind] = new Set(parameters.getAll(kind));
  });
  elements.search.value = state.query;
  const hash = window.location.hash;
  state.requestedId = hash.startsWith('#card=') ? hash.slice(6) : null;
}

function writeLocation() {
  const parameters = new URLSearchParams();
  if (state.query) parameters.set('q', state.query);
  KINDS.forEach((kind) => state.filters[kind].forEach((key) => parameters.append(kind, key)));
  const search = parameters.toString();
  const hash = state.selectedId ? `#card=${state.selectedId}` : '';
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${search ? `?${search}` : ''}${hash}`,
  );
}

function activeFilterCount() {
  return KINDS.reduce((sum, kind) => sum + state.filters[kind].size, 0) + (state.query ? 1 : 0);
}

// --- Filters -------------------------------------------------------------

function setFilter(kind, key, checked) {
  if (checked) state.filters[kind].add(key);
  else state.filters[kind].delete(key);
  syncFilterControls();
  loadCards();
}

function ancestorKeys(kind, entry) {
  const nodes = state.nodesById[kind];
  const keys = [];
  let parent = nodes.get(entry.parent_id);
  while (parent) {
    keys.push(parent.key);
    parent = nodes.get(parent.parent_id);
  }
  return keys;
}

function syncFilterControls() {
  KINDS.forEach((kind) => {
    const selected = state.filters[kind];
    const group = elements.filterGroups.querySelector(`[data-kind="${kind}"]`);
    if (!group) return;
    group.querySelectorAll('.filter-option').forEach((option) => {
      const input = option.querySelector('input');
      input.checked = selected.has(input.value);
      const implied = option.dataset.ancestors.split(' ').some((key) => key && selected.has(key));
      option.classList.toggle('implied', implied && !input.checked);
    });
    const badge = group.querySelector('.filter-group-selected');
    badge.textContent = selected.size ? String(selected.size) : '';
    badge.hidden = !selected.size;
  });
  const count = activeFilterCount();
  elements.clearFilters.textContent = count ? `Clear (${count})` : 'Clear';
  elements.clearFilters.disabled = !count;
  renderActiveFilters();
}

function renderActiveFilters() {
  const chips = [];
  if (state.query) {
    chips.push(
      createChip(`“${state.query}”`, 'Search', () => {
        elements.search.value = '';
        state.query = '';
        syncFilterControls();
        loadCards();
      }),
    );
  }
  KINDS.forEach((kind) => {
    state.filters[kind].forEach((key) => {
      const entry = state.taxonomy[kind].get(key);
      chips.push(
        createChip(entry?.name || key, KIND_LABELS[kind], () => setFilter(kind, key, false), kind),
      );
    });
  });
  elements.activeFilters.replaceChildren(...chips);
  elements.activeFilters.hidden = !chips.length;
}

function createChip(label, title, onRemove, kind) {
  const chip = createElement('button', `filter-chip${kind ? ` chip-${kind}` : ''}`);
  chip.type = 'button';
  chip.title = `Remove ${title.toLowerCase()} filter`;
  chip.append(createElement('span', 'filter-chip-kind', title), createElement('span', null, label));
  chip.append(createElement('span', 'filter-chip-remove', '×'));
  chip.addEventListener('click', onRemove);
  return chip;
}

function renderTaxonomyGroup(kind, entries) {
  const nodes = state.nodesById[kind];
  const section = createElement('section', 'filter-group');
  section.dataset.kind = kind;
  const expanded = kind === 'domain' || state.filters[kind].size > 0;

  const heading = createElement('button', 'filter-group-heading');
  heading.type = 'button';
  heading.setAttribute('aria-expanded', String(expanded));
  heading.append(
    createElement('span', null, KIND_LABELS[kind]),
    createElement('span', 'filter-group-selected'),
    createElement('span', 'filter-group-count', String(entries.length)),
  );

  const body = createElement('div', 'filter-body');
  body.hidden = !expanded;

  const options = createElement('div', 'filter-options');
  const minimumDepth = Math.min(...entries.map((entry) => entry.depth));
  const rows = entries.map((entry) => {
    const label = createElement('label', 'filter-option');
    label.style.setProperty('--depth', String(entry.depth - minimumDepth));
    label.dataset.ancestors = ancestorKeys(kind, entry).join(' ');
    label.dataset.search = foldText(entry.name);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = kind;
    input.value = entry.key;
    const indicator = createElement('span', 'check-indicator');
    const text = createElement('span', 'filter-option-label', entry.name);
    const code = isoLabel(entry);
    if (code) text.append(' ', createElement('span', 'iso-code', code));
    if (kind === 'proliferation' && !nodes.has(entry.parent_id)) {
      label.classList.add('filter-option-region');
    }
    const count = createElement('span', 'filter-option-count', String(entry.card_count));
    label.append(input, indicator, text, count);
    options.append(label);
    input.addEventListener('change', () => setFilter(kind, entry.key, input.checked));
    return { label, entry };
  });

  if (entries.length > QUICK_FILTER_THRESHOLD) {
    const quick = document.createElement('input');
    quick.type = 'search';
    quick.className = 'quick-filter';
    quick.placeholder = `Find in ${KIND_LABELS[kind].toLowerCase()}…`;
    quick.setAttribute('aria-label', `Find in ${KIND_LABELS[kind]}`);
    const empty = createElement('p', 'filter-empty', 'No match.');
    empty.hidden = true;
    quick.addEventListener('input', () => {
      const needle = foldText(quick.value.trim());
      const visible = new Set();
      if (needle) {
        rows.forEach(({ label, entry }) => {
          if (label.dataset.search.includes(needle)) {
            visible.add(entry.key);
            ancestorKeys(kind, entry).forEach((key) => visible.add(key));
          }
        });
      }
      rows.forEach(({ label, entry }) => {
        label.hidden = Boolean(needle) && !visible.has(entry.key);
      });
      empty.hidden = !needle || visible.size > 0;
    });
    body.append(quick, empty);
  }

  heading.addEventListener('click', () => {
    const isExpanded = heading.getAttribute('aria-expanded') === 'true';
    heading.setAttribute('aria-expanded', String(!isExpanded));
    body.hidden = isExpanded;
  });
  body.append(options);
  section.append(heading, body);
  return section;
}

function renderStatus(status, stats) {
  const light = createElement('span', 'status-light');
  light.setAttribute('aria-hidden', 'true');
  const source = createElement('div', 'source-status');
  source.append(light, createElement('span', null, 'Official public data'));
  const list = createElement('dl', 'header-stats');
  list.setAttribute('aria-label', 'Database statistics');
  for (const [term, value] of [
    ['Cards', String(stats.counts.cards)],
    ['Updated', formatDate(stats.source.source_updated_at)],
  ]) {
    const item = createElement('div');
    item.append(createElement('dt', null, term), createElement('dd', null, value));
    list.append(item);
  }
  status.replaceChildren(source, list);
}

async function loadFoundation(status) {
  const [stats, taxonomy] = await Promise.all([
    requestJson(`${API}/stats`),
    requestJson(`${API}/taxonomy?used_only=true`),
  ]);
  renderStatus(status, stats);
  KINDS.forEach((kind) => {
    state.taxonomy[kind] = new Map(taxonomy[kind].map((entry) => [entry.key, entry]));
    state.nodesById[kind] = new Map(taxonomy[kind].map((entry) => [entry.id, entry]));
    // Drop URL keys that the taxonomy no longer knows.
    state.filters[kind].forEach((key) => {
      if (!state.taxonomy[kind].has(key)) state.filters[kind].delete(key);
    });
  });
  elements.filterGroups.replaceChildren(
    ...KINDS.map((kind) => renderTaxonomyGroup(kind, taxonomy[kind])),
  );
  syncFilterControls();
}

// --- Results -------------------------------------------------------------

function renderSnippet(snippet) {
  const node = createElement('span', 'equipment-snippet');
  snippet
    .replace(/\s+/g, ' ')
    .split(/(\[[^\]]*\])/)
    .forEach((part) => {
      if (part.startsWith('[') && part.endsWith(']')) {
        node.append(createElement('mark', null, part.slice(1, -1)));
      } else if (part) {
        node.append(part);
      }
    });
  return node;
}

function renderCard(item, index) {
  const button = createElement('button', 'equipment-card');
  button.type = 'button';
  button.dataset.identifier = item.identifier;
  button.setAttribute('aria-pressed', String(item.identifier === state.selectedId));

  const media = createElement('span', 'equipment-media');
  if (item.image_url) {
    const image = document.createElement('img');
    image.src = item.image_url;
    image.alt = '';
    image.loading = index < 6 ? 'eager' : 'lazy';
    media.append(image);
  } else {
    media.append(createElement('span', 'image-missing', 'NO IMAGE'));
  }

  const body = createElement('span', 'equipment-body');
  const serial = createElement('span', 'equipment-serial', String(index + 1).padStart(2, '0'));
  const title = createElement('strong', null, item.name.trim());
  const meta = createElement('span', 'equipment-meta');
  const year = item.date_of_introduction ? item.date_of_introduction.slice(0, 4) : '—';
  const category = item.domains.at(-1) || 'Uncategorized';
  const origin = item.origins.join(', ');
  meta.append(
    createElement('span', null, origin ? `${category} · ${origin}` : category),
    createElement('span', null, year),
  );
  body.append(serial, title);
  if (item.match) body.append(renderSnippet(item.match));
  body.append(meta);
  button.append(media, body);
  button.addEventListener('click', () => selectCard(item.identifier, true));
  return button;
}

function renderCards() {
  elements.cardList.replaceChildren(...state.cards.map(renderCard));
  elements.resultCount.textContent =
    state.cards.length === state.total
      ? String(state.total)
      : `${state.cards.length} / ${state.total}`;
  elements.resultOrder.textContent = state.query ? 'Best match first' : 'Source order';
  elements.loadMore.hidden = state.cards.length >= state.total;
  elements.loadMore.textContent = `Load ${Math.min(PAGE_SIZE, state.total - state.cards.length)} more`;
  if (state.cards.length) {
    elements.resultStatus.hidden = true;
    return;
  }
  elements.resultStatus.hidden = false;
  elements.resultStatus.replaceChildren(
    createElement('p', null, 'No records match these controls.'),
  );
  if (activeFilterCount()) {
    const reset = createElement('button', 'text-button', 'Clear all filters');
    reset.type = 'button';
    reset.addEventListener('click', resetFilters);
    elements.resultStatus.append(reset);
  }
}

async function loadCards(append = false) {
  state.request?.abort();
  state.request = new AbortController();
  const parameters = new URLSearchParams();
  if (state.query) parameters.set('q', state.query);
  KINDS.forEach((kind) => state.filters[kind].forEach((key) => parameters.append(kind, key)));
  parameters.set('limit', String(PAGE_SIZE));
  parameters.set('offset', String(append ? state.cards.length : 0));
  if (!append) writeLocation();
  elements.resultStatus.hidden = false;
  elements.resultStatus.textContent = append ? 'Loading more records…' : 'Filtering local index…';
  elements.cardList.classList.add('is-loading');
  try {
    const result = await requestJson(
      `${API}/cards?${parameters}`,
      AbortSignal.any([state.request.signal, state.session.signal]),
    );
    state.cards = append ? [...state.cards, ...result.items] : result.items;
    state.total = result.total;
    elements.cardList.classList.remove('is-loading');
    renderCards();
    if (append) return;
    const inList = (id) => id && state.cards.some((card) => card.identifier === id);
    if (state.requestedId) {
      // A deep link opens its card even when the current filters hide it.
      const requestedId = state.requestedId;
      state.requestedId = null;
      await selectCard(requestedId, false);
    } else if (inList(state.selectedId)) {
      writeLocation();
    } else {
      clearDetail();
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    elements.cardList.classList.remove('is-loading');
    elements.resultStatus.hidden = false;
    elements.resultStatus.textContent = error.message;
  }
}

// --- Detail --------------------------------------------------------------

function renderTag(item) {
  const known = state.taxonomy[item.kind].has(item.source_key);
  const tag = createElement(known ? 'button' : 'span', `tag tag-${item.kind}`, item.value);
  if (!known) return tag;
  tag.type = 'button';
  const active = state.filters[item.kind].has(item.source_key);
  tag.setAttribute('aria-pressed', String(active));
  tag.title = active
    ? `Remove ${item.value} filter`
    : `Filter by ${KIND_LABELS[item.kind].toLowerCase()}: ${item.value}`;
  tag.addEventListener('click', () => setFilter(item.kind, item.source_key, !active));
  return tag;
}

function renderTagRow(items) {
  const row = createElement('div', 'classification-row');
  items.forEach((item) => row.append(renderTag(item)));
  return row;
}

function renderGallery(images, name) {
  const gallery = createElement('div', 'gallery');
  const main = createElement('figure', 'main-image');
  const image = document.createElement('img');
  image.alt = name;
  if (images[0]) image.src = images[0].url;
  main.append(image);
  gallery.append(main);
  if (images.length > 1) {
    const strip = createElement('div', 'thumbnail-strip');
    images.forEach((entry, index) => {
      const button = createElement('button', 'thumbnail');
      button.type = 'button';
      button.setAttribute('aria-label', `Show image ${index + 1}`);
      const thumbnail = document.createElement('img');
      thumbnail.src = entry.url;
      thumbnail.alt = '';
      button.append(thumbnail);
      button.addEventListener('click', () => {
        image.src = entry.url;
        strip.querySelectorAll('button').forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
      });
      if (index === 0) button.classList.add('active');
      strip.append(button);
    });
    gallery.append(strip);
  }
  return gallery;
}

function renderProperty(property) {
  const row = createElement('div', 'property-row');
  row.append(createElement('dt', null, property.name || 'Value'));
  const value = createElement('dd');
  value.append(document.createTextNode(property.value || '—'));
  if (property.units && !property.value.includes(property.units)) {
    value.append(createElement('span', 'unit', property.units));
  }
  row.append(value);
  return row;
}

function renderSection(section, depth = 0) {
  const wrapper = createElement('section', `spec-section depth-${Math.min(depth, 2)}`);
  const heading = createElement(depth ? 'h4' : 'h3', null, section.name || 'Specifications');
  wrapper.append(heading);
  if (section.properties.length) {
    const list = createElement('dl', 'property-list');
    section.properties.forEach((property) => list.append(renderProperty(property)));
    wrapper.append(list);
  }
  section.sections.forEach((child) => wrapper.append(renderSection(child, depth + 1)));
  return wrapper;
}

function renderDetail(card) {
  elements.detail.replaceChildren();
  const header = createElement('header', 'detail-header');
  const overline = createElement('div', 'detail-overline');
  overline.append(
    createElement('span', null, `CARD ${String(card.source_ordinal + 1).padStart(2, '0')}`),
    createElement('span', null, card.display_name || 'WEG RECORD'),
  );
  const depthOf = (item) => state.taxonomy.domain.get(item.source_key)?.depth ?? item.ordinal;
  const domains = card.classifications
    .filter((item) => item.kind === 'domain')
    .sort((a, b) => depthOf(a) - depthOf(b));
  const origins = card.classifications.filter((item) => item.kind === 'origin');
  const headline = [...domains, ...origins];
  header.append(overline, createElement('h2', null, card.name.trim()), renderTagRow(headline));

  const summary = createElement('section', 'detail-summary');
  summary.append(renderGallery(card.images, card.name));
  const copy = createElement('div', 'summary-copy');
  const date = createElement('dl', 'quick-facts');
  const users = card.classifications.filter((item) => item.kind === 'proliferation');
  date.append(
    createElement('dt', null, 'Introduced'),
    createElement('dd', null, card.date_of_introduction?.slice(0, 4) || 'Unknown'),
    createElement('dt', null, 'Updated'),
    createElement('dd', null, formatDate(card.modified_date)),
    createElement('dt', null, 'Users'),
    createElement('dd', null, users.length ? String(users.length) : 'None listed'),
  );
  const notes = createElement('div', 'notes');
  card.notes
    .split(/\n\s*\n/)
    .filter(Boolean)
    .forEach((paragraph) => notes.append(createElement('p', null, paragraph)));
  copy.append(date, notes);
  summary.append(copy);

  const specifications = createElement('div', 'specifications');
  if (users.length) {
    const wrapper = createElement('section', 'spec-section depth-0 user-list');
    wrapper.append(createElement('h3', null, 'Proliferation'), renderTagRow(users));
    specifications.append(wrapper);
  }
  card.sections.forEach((section) => specifications.append(renderSection(section)));
  elements.detail.append(header, summary, specifications);
}

async function selectCard(identifier, updateLocation) {
  if (!identifier) return;
  state.selectedId = identifier;
  elements.cardList.querySelectorAll('.equipment-card').forEach((card) => {
    card.setAttribute('aria-pressed', String(card.dataset.identifier === identifier));
  });
  elements.detailEmpty.hidden = true;
  elements.detail.hidden = false;
  elements.detail.replaceChildren(
    createElement('div', 'loading-state detail-loading', 'Opening card…'),
  );
  try {
    const card = await requestJson(`${API}/cards/${encodeURIComponent(identifier)}`);
    if (identifier !== state.selectedId) return;
    renderDetail(card);
    writeLocation();
    if (updateLocation) {
      elements.detailPanel.scrollTo({ top: 0 });
      if (window.matchMedia('(max-width: 900px)').matches) {
        elements.detailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    elements.detail.replaceChildren(createElement('div', 'loading-state', error.message));
  }
}

function clearDetail() {
  state.selectedId = null;
  elements.detail.hidden = true;
  elements.detailEmpty.hidden = false;
  writeLocation();
}

// --- Wiring --------------------------------------------------------------

function resetFilters() {
  elements.search.value = '';
  state.query = '';
  KINDS.forEach((kind) => state.filters[kind].clear());
  elements.filterGroups.querySelectorAll('.quick-filter').forEach((input) => {
    input.value = '';
    input.dispatchEvent(new Event('input'));
  });
  syncFilterControls();
  loadCards();
}

function focusSearchShortcut(event) {
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  event.preventDefault();
  elements.search.focus();
  elements.search.select();
}

export function mount({ root, status }) {
  root.innerHTML = template;
  state = createState();
  elements = queryElements(root);
  const { session } = state;

  let searchTimer;
  elements.search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      const next = elements.search.value.trim();
      if (next === state.query) return;
      state.query = next;
      syncFilterControls();
      loadCards();
    }, 180);
  });
  elements.search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && elements.search.value) {
      elements.search.value = '';
      elements.search.dispatchEvent(new Event('input'));
    }
  });
  document.addEventListener('keydown', focusSearchShortcut);
  elements.clearFilters.addEventListener('click', resetFilters);
  elements.loadMore.addEventListener('click', () => loadCards(true));

  readLocation();
  loadFoundation(status)
    .then(() => loadCards())
    .catch((error) => {
      if (error.name === 'AbortError') return;
      elements.resultStatus.textContent = error.message;
    });

  return () => {
    window.clearTimeout(searchTimer);
    document.removeEventListener('keydown', focusSearchShortcut);
    session.abort();
    root.replaceChildren();
  };
}
