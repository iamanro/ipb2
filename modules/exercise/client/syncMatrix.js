/**
 * The ISR synchronization matrix: an SVG Gantt of collection taskings over
 * scenario time, rows grouped PIR › SIR › NAI. Pure layout/detection
 * (`computeTimeWindow`, `zoomWindow`, `timeScale`, `buildMatrixRows`,
 * `findUncoveredSirs`) is unit-tested in `syncMatrix.test.js`; only
 * `renderSyncMatrixSvg` touches the DOM.
 */

const HOUR = 3_600_000;

/** Quick-zoom presets (hours), narrowest first. */
export const ZOOM_PRESETS = [6, 24, 72];

/** Discipline → legend colour. Distinct from affiliation colours used elsewhere in Exercise. */
export const DISCIPLINE_COLOR = {
  HUMINT: '#e07a5f',
  SIGINT: '#3d8bff',
  IMINT: '#3fbf5f',
  GEOINT: '#9b59b6',
  OSINT: '#e6c229',
  MASINT: '#00bcd4',
  UAS: '#ff8a65',
  RECCE: '#8bc34a',
  OP: '#c9a55c',
  OTHER: '#8ea2a8',
};

/** Short tags so the bars aren't colour-only: printed inside/under each bar and in the legend. */
export const DISCIPLINE_TAG = {
  HUMINT: 'HUM',
  SIGINT: 'SIG',
  IMINT: 'IMI',
  GEOINT: 'GEO',
  OSINT: 'OSI',
  MASINT: 'MAS',
  UAS: 'UAS',
  RECCE: 'RCE',
  OP: 'OP',
  OTHER: 'OTH',
};

/**
 * Auto-fit window over every tasking's [start_at, end_at] plus any LTIOV,
 * padded by an hour either side; falls back to now ± 3h with nothing to fit.
 */
export function computeTimeWindow(taskings, ltiovTimes = [], nowMs = Date.now(), { paddingHours = 1 } = {}) {
  const times = [
    ...taskings.map((t) => new Date(t.start_at).getTime()),
    ...taskings.map((t) => new Date(t.end_at).getTime()),
    ...ltiovTimes.filter((ms) => Number.isFinite(ms)),
  ].filter((ms) => Number.isFinite(ms));
  if (!times.length) return { start: nowMs - 3 * HOUR, end: nowMs + 3 * HOUR };
  const pad = paddingHours * HOUR;
  return { start: Math.min(...times, nowMs) - pad, end: Math.max(...times, nowMs) + pad };
}

/** A fixed-width window of `hours` centred on `centerMs` (a zoom button). */
export function zoomWindow(centerMs, hours) {
  const half = (hours * HOUR) / 2;
  return { start: centerMs - half, end: centerMs + half };
}

/** `ms -> x` (px) linear map over `[start, end] -> [0, width]`; clamps to the span. */
export function timeScale(start, end, width) {
  const span = Math.max(end - start, 1);
  return (ms) => ((ms - start) / span) * width;
}

/**
 * Requirements (with their `.sirs`) plus the tasking list into an ordered
 * row list for the Gantt: one 'pir' row per requirement that has SIRs, then
 * one 'sir' row per SIR carrying its taskings (start-sorted) and its PIR's
 * LTIOV (ms, or null). Requirements without SIRs are dropped — nothing to
 * task or draw.
 */
export function buildMatrixRows(requirements, taskings, nais) {
  const naiById = new Map(nais.map((n) => [n.id, n]));
  const taskingsBySir = new Map();
  for (const tasking of taskings) {
    if (!taskingsBySir.has(tasking.sir_id)) taskingsBySir.set(tasking.sir_id, []);
    taskingsBySir.get(tasking.sir_id).push(tasking);
  }
  const rows = [];
  for (const requirement of requirements) {
    if (!requirement.sirs?.length) continue;
    const ltiov = requirement.ltiov ? new Date(requirement.ltiov).getTime() : null;
    rows.push({ kind: 'pir', id: requirement.id, label: requirement.text, ltiov });
    for (const sir of requirement.sirs) {
      const nai = sir.nai_id ? naiById.get(sir.nai_id) : null;
      rows.push({
        kind: 'sir',
        id: sir.id,
        pirId: requirement.id,
        label: nai ? `${sir.text} — NAI ${nai.label}` : sir.text,
        ltiov,
        taskings: (taskingsBySir.get(sir.id) || [])
          .slice()
          .sort((a, b) => new Date(a.start_at) - new Date(b.start_at)),
      });
    }
  }
  return rows;
}

/**
 * SIR rows with no tasking that reports (ends) on or before their PIR's
 * LTIOV — or, when the PIR has no LTIOV, no tasking at all. A SIR with
 * *some* tasking but none finishing before an existing LTIOV is still
 * uncovered: the collection plan won't answer the PIR in time.
 */
export function findUncoveredSirs(rows) {
  return rows.filter((row) => {
    if (row.kind !== 'sir') return false;
    if (row.ltiov === null) return row.taskings.length === 0;
    return !row.taskings.some((t) => new Date(t.end_at).getTime() <= row.ltiov);
  });
}

/** Two taskings overlap in time (open interval — touching ends don't conflict). */
function overlaps(a, b) {
  return new Date(a.start_at) < new Date(b.end_at) && new Date(b.start_at) < new Date(a.end_at);
}

/** `tasking.id -> true` for taskings named by `GET collection/conflicts`. */
export function conflictTaskingIds(conflicts) {
  const ids = new Set();
  for (const entry of conflicts?.overlaps ?? []) entry.tasking_ids.forEach((id) => ids.add(id));
  for (const entry of conflicts?.outside ?? []) ids.add(entry.tasking_id);
  return ids;
}

/** Human list of the taskings that clash with `taskingId`, for a title/tooltip. */
export function conflictDescription(conflicts, taskingId, taskingsById) {
  const parts = [];
  for (const entry of conflicts?.overlaps ?? []) {
    if (!entry.tasking_ids.includes(taskingId)) continue;
    const other = entry.tasking_ids.find((id) => id !== taskingId);
    const otherTasking = taskingsById.get(other);
    parts.push(`overlaps tasking #${other}${otherTasking ? ` (${otherTasking.sor})` : ''}`);
  }
  for (const entry of conflicts?.outside ?? []) {
    if (entry.tasking_id === taskingId) parts.push('scheduled outside the collector\u2019s availability window');
  }
  return parts.join('; ');
}

export { overlaps as _overlaps };

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

const ROW_H = 28;
const LABEL_W = 280;
const CHART_W = 820;
const PADDING = 10;
const HEADER_H = 26;

/**
 * Builds the Gantt as an inline `<svg>` (not appended). `taskingsById` and
 * `collectorsById` are `Map`s for the tooltip text; `onSelectTasking(id)`
 * (optional) is wired to each bar's click/keydown.
 */
export function renderSyncMatrixSvg({
  rows,
  window: timeWindow,
  now,
  conflicts,
  collectorsById,
  taskingsById,
  onSelectTasking,
}) {
  const scale = timeScale(timeWindow.start, timeWindow.end, CHART_W);
  const conflictIds = conflictTaskingIds(conflicts);
  const height = HEADER_H + rows.length * ROW_H + PADDING;
  const width = LABEL_W + CHART_W + PADDING * 2;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    role: 'img',
    'aria-label': 'ISR synchronization matrix: taskings by PIR, SIR and NAI over scenario time',
    class: 'sync-matrix-svg',
  });

  const defs = svgEl('defs');
  const hatch = svgEl('pattern', {
    id: 'sync-hatch',
    width: 6,
    height: 6,
    patternTransform: 'rotate(45)',
    patternUnits: 'userSpaceOnUse',
  });
  hatch.append(svgEl('rect', { width: 6, height: 6, fill: 'var(--surface)' }));
  hatch.append(svgEl('path', { d: 'M0,0 L0,6', stroke: 'currentColor', 'stroke-width': 3 }));
  defs.append(hatch);
  svg.append(defs);

  // Time axis ticks (hourly if the window is short, else every few hours).
  const spanHours = (timeWindow.end - timeWindow.start) / HOUR;
  const step = spanHours <= 12 ? 1 : spanHours <= 48 ? 4 : 12;
  for (let h = Math.ceil(timeWindow.start / HOUR / step) * step; h * HOUR < timeWindow.end; h += step) {
    const ms = h * HOUR;
    const x = LABEL_W + PADDING + scale(ms);
    svg.append(
      svgEl('line', {
        x1: x,
        x2: x,
        y1: HEADER_H,
        y2: height,
        class: 'sync-tick',
      }),
    );
    const label = svgEl('text', { x: x + 2, y: HEADER_H - 8, class: 'sync-tick-label' });
    label.textContent = new Date(ms).toISOString().slice(11, 16) + 'Z';
    svg.append(label);
  }

  rows.forEach((row, index) => {
    const y = HEADER_H + index * ROW_H;
    const rowGroup = svgEl('g', { class: `sync-row sync-row-${row.kind}` });

    if (row.kind === 'pir') {
      rowGroup.append(svgEl('rect', { x: 0, y, width, height: ROW_H, class: 'sync-pir-band' }));
    }
    const label = svgEl('text', {
      x: row.kind === 'pir' ? 6 : 18,
      y: y + ROW_H / 2 + 4,
      class: row.kind === 'pir' ? 'sync-pir-label' : 'sync-sir-label',
    });
    label.textContent = row.label;
    rowGroup.append(label);

    const clipPath = svgEl('clipPath', { id: `sync-label-clip-${index}` });
    clipPath.append(svgEl('rect', { x: 0, y, width: LABEL_W, height: ROW_H }));
    defs.append(clipPath);
    label.setAttribute('clip-path', `url(#sync-label-clip-${index})`);

    if (row.kind === 'pir' && row.ltiov !== null && row.ltiov >= timeWindow.start && row.ltiov <= timeWindow.end) {
      const x = LABEL_W + PADDING + scale(row.ltiov);
      const tick = svgEl('g', { class: 'sync-ltiov' });
      tick.append(svgEl('line', { x1: x, x2: x, y1: y, y2: y + ROW_H }));
      const tickTitle = svgEl('title');
      tickTitle.textContent = `LTIOV ${new Date(row.ltiov).toISOString()}`;
      tick.append(tickTitle);
      rowGroup.append(tick);
    }

    if (row.kind === 'sir') {
      for (const tasking of row.taskings) {
        const startX = LABEL_W + PADDING + scale(new Date(tasking.start_at).getTime());
        const endX = LABEL_W + PADDING + scale(new Date(tasking.end_at).getTime());
        const barWidth = Math.max(endX - startX, 3);
        const collector = collectorsById.get(tasking.collector_id);
        const color = DISCIPLINE_COLOR[collector?.discipline] ?? DISCIPLINE_COLOR.OTHER;
        const conflicted = conflictIds.has(tasking.id);
        const bar = svgEl('rect', {
          x: startX,
          y: y + 4,
          width: barWidth,
          height: ROW_H - 8,
          rx: 2,
          class: `sync-bar sync-status-${tasking.status}${conflicted ? ' sync-conflict' : ''}`,
          style: `--bar-color:${color}`,
          tabindex: onSelectTasking ? 0 : -1,
          role: onSelectTasking ? 'button' : undefined,
        });
        const titleText = [
          `${collector?.name ?? `Collector #${tasking.collector_id}`} (${collector?.discipline ?? '?'})`,
          `${tasking.status}`,
          `${tasking.start_at} \u2192 ${tasking.end_at}`,
          conflicted ? `CONFLICT: ${conflictDescription(conflicts, tasking.id, taskingsById)}` : null,
        ]
          .filter(Boolean)
          .join('\n');
        bar.append(Object.assign(svgEl('title'), { textContent: titleText }));
        if (onSelectTasking) {
          bar.addEventListener('click', () => onSelectTasking(tasking.id));
          bar.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelectTasking(tasking.id);
            }
          });
        }
        rowGroup.append(bar);
        if (barWidth > 26) {
          const tag = svgEl('text', { x: startX + 4, y: y + ROW_H / 2 + 3, class: 'sync-bar-tag' });
          tag.textContent = DISCIPLINE_TAG[collector?.discipline] ?? '?';
          rowGroup.append(tag);
        }
        if (conflicted) {
          const warn = svgEl('text', { x: endX - 14, y: y + ROW_H / 2 + 4, class: 'sync-conflict-icon' });
          warn.textContent = '\u26A0';
          rowGroup.append(warn);
        }
      }
    }
    svg.append(rowGroup);
  });

  if (now >= timeWindow.start && now <= timeWindow.end) {
    const x = LABEL_W + PADDING + scale(now);
    svg.append(svgEl('line', { x1: x, x2: x, y1: 0, y2: height, class: 'sync-now-line' }));
    const nowLabel = svgEl('text', { x: x + 3, y: 12, class: 'sync-now-label' });
    nowLabel.textContent = 'NOW';
    svg.append(nowLabel);
  }

  return svg;
}
