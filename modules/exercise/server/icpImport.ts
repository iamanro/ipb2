import { HttpError } from '../../../server/http.ts';
import { readZipEntries } from '../../../server/zip.ts';
import type { PlannedIndicator, PlannedRequirement, PlannedSir } from './ipbImport.ts';

/**
 * Turns an Intelligence Collection Plan workbook (the PSAF F HQ ICP layout:
 * one row per EEI under merged PIR/SIR cells, a `No.` header row, the
 * collector codes in the row above it, product references in the last
 * column) into PIR/SIR/indicator rows keyed by a stable `source`, so
 * importing a revised workbook updates instead of duplicating:
 *
 *   PIR row (A/B)   -> PIR        PIR 1 gets the highest priority
 *   SIR (C/D)       -> SIR        "SIR 1.1 <question>"
 *   EEI row (E–AE)  -> indicator  EEI text + indicators, NAI, window, collectors
 *
 * NAI cells are free text ranges ("JTF NAI 001–004, 014 and 019") with no
 * geometry in the workbook, so they stay in the indicator wording rather
 * than becoming NAI rows. Pure apart from unzipping: no database, no clock.
 */

type Rows = Map<number, Map<string, string>>;

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXml(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name] ?? match;
  });
}

/** The text of every `<t>` run inside `xml`, concatenated (a rich-text cell has several). */
function runsText(xml: string) {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');
}

/** The first worksheet's non-empty cells as row number -> column letters -> trimmed text. */
export function readXlsxRows(buffer: Buffer): Rows {
  let entries;
  try {
    entries = new Map(
      readZipEntries(buffer).map((entry) => [entry.name, entry.data.toString('utf8')]),
    );
  } catch {
    throw new HttpError(400, 'The file is not an .xlsx workbook.');
  }
  const workbook = entries.get('xl/workbook.xml');
  const rels = entries.get('xl/_rels/workbook.xml.rels');
  const firstSheetId = workbook?.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
  const target = firstSheetId
    ? (rels?.match(
        new RegExp(`<Relationship\\b[^>]*Id="${firstSheetId}"[^>]*Target="([^"]+)"`),
      )?.[1] ??
      rels?.match(
        new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstSheetId}"`),
      )?.[1])
    : undefined;
  const sheetPath = target?.startsWith('/') ? target.slice(1) : target && `xl/${target}`;
  const sheet = sheetPath ? entries.get(sheetPath) : undefined;
  if (!sheet) throw new HttpError(400, 'The workbook has no readable first sheet.');

  const shared = [
    ...(entries.get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((m) => runsText(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')));
  const rows: Rows = new Map();
  for (const match of sheet.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attributes = match[1];
    const body = match[2] ?? '';
    const ref = attributes.match(/\br="([A-Z]+)(\d+)"/);
    if (!ref) continue;
    const type = attributes.match(/\bt="(\w+)"/)?.[1];
    const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
    const value =
      type === 's'
        ? (shared[Number(raw)] ?? '')
        : type === 'inlineStr'
          ? runsText(body)
          : raw === undefined
            ? ''
            : decodeXml(raw);
    const clean = value.trim();
    if (!clean) continue;
    const row = Number(ref[2]);
    if (!rows.has(row)) rows.set(row, new Map());
    rows.get(row)?.set(ref[1], clean);
  }
  return rows;
}

/** 'A' -> 0, 'AE' -> 30: for walking the collector columns in order. */
function columnIndex(letters: string) {
  let total = 0;
  for (let i = 0; i < letters.length; i += 1) total = total * 26 + letters.charCodeAt(i) - 64;
  return total - 1;
}

function columnLetters(index: number): string {
  return index < 26
    ? String.fromCharCode(65 + index)
    : columnLetters(Math.floor(index / 26) - 1) + String.fromCharCode(65 + (index % 26));
}

/** "1.2.1 / " or "1." -> "1.2.1" / "1". */
function number(text: string | undefined) {
  return (text ?? '').split(/[\s/]/)[0].replace(/\.+$/, '');
}

/** One `Key: value` segment of the pipe-separated product-references cell. */
function segment(references: string, key: string) {
  return references
    .split('|')
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith(`${key.toLowerCase()}:`))
    ?.slice(key.length + 1)
    .trim();
}

export function planIcpImport(rows: Rows, prefix: string) {
  const ordered = [...rows.keys()].sort((a, b) => a - b);
  const headerRow = ordered.find((row) => rows.get(row)?.get('A') === 'No.');
  if (headerRow === undefined) {
    throw new HttpError(400, 'Not a collection plan: no header row starting with "No.".');
  }
  // Collector codes (MALE, GEO, 1BCT, …) sit in the row just above "No.",
  // from column J up to the last column before the product references.
  const codes = [...(rows.get(headerRow - 1) ?? new Map<string, string>())]
    .filter(([column]) => columnIndex(column) >= columnIndex('J'))
    .sort(([a], [b]) => columnIndex(a) - columnIndex(b));
  // Product references (precedence | Decision: … | LTIOV: …) follow the last collector column.
  const referencesColumn = codes.length
    ? columnLetters(columnIndex(codes[codes.length - 1][0]) + 1)
    : 'AE';

  const requirements: (PlannedRequirement & { decisions: string[] })[] = [];
  const sirs: PlannedSir[] = [];
  const indicators: PlannedIndicator[] = [];
  let pir: (typeof requirements)[number] | null = null;
  let sir: PlannedSir | null = null;

  for (const rowNumber of ordered.filter((row) => row > headerRow)) {
    const row = rows.get(rowNumber) ?? new Map<string, string>();
    if (/^legend/i.test(row.get('A') ?? '')) break;
    if (row.get('B')) {
      const pirNumber = number(row.get('A'));
      pir = {
        source: `${prefix}pir:${pirNumber}`,
        text: row.get('B') ?? '',
        decisions: [],
      };
      requirements.push(pir);
      sir = null;
    }
    if (row.get('D')) {
      if (!pir) throw new HttpError(400, `Row ${rowNumber}: a SIR before any PIR.`);
      const sirNumber = number(row.get('C'));
      sir = {
        source: `${prefix}sir:${sirNumber}`,
        requirementSource: pir.source,
        text: `SIR ${sirNumber} ${row.get('D')}`,
        naiSource: null,
      };
      sirs.push(sir);
    }
    if (!row.get('F')) continue;
    if (!pir || !sir) throw new HttpError(400, `Row ${rowNumber}: an EEI before any PIR/SIR.`);
    const eei = number(row.get('E'));
    const references = row.get(referencesColumn) ?? '';
    for (const point of segment(references, 'Decision')?.match(/\bDP\s?\d+/g) ?? []) {
      const clean = point.replace(/\s/g, '');
      if (!pir.decisions.includes(clean)) pir.decisions.push(clean);
    }
    const byCode = (wanted: string) =>
      codes.filter(([column]) => row.get(column)?.toUpperCase() === wanted).map(([, code]) => code);
    const collection = (
      [
        ['tasked', 'T'],
        ['capable', 'C'],
        ['request', 'R'],
      ] as const
    )
      .map(([label, wanted]) => [label, byCode(wanted)] as const)
      .filter(([, list]) => list.length)
      .map(([label, list]) => `${label} ${list.join(', ')}`)
      .join('; ');
    const precedence = references.split('|')[0]?.trim();
    const ltiov = segment(references, 'LTIOV');
    indicators.push({
      source: `${prefix}eei:${eei}`,
      sirSource: sir.source,
      description: [
        `EEI ${eei} — ${row.get('F')}`,
        row.get('G') && `Indicators: ${row.get('G')}`,
        row.get('H') && `NAI: ${row.get('H')}`,
        row.get('I') && `Window: ${row.get('I')}`,
        collection && `Collection: ${collection}`,
        precedence && !precedence.includes(':') && `Precedence: ${precedence}`,
        ltiov && `LTIOV: ${ltiov}`,
      ]
        .filter(Boolean)
        .join('. '),
      observed: false,
    });
  }
  if (!requirements.length) throw new HttpError(400, 'The collection plan lists no PIRs.');
  return {
    prefix,
    nais: [],
    // The exercise lists the highest priority first; PIR 1 is the most important.
    requirements: requirements.map(({ decisions, ...requirement }, index) => ({
      ...requirement,
      priority: requirements.length - index,
      decision_point: decisions.sort().join(', ') || null,
    })),
    sirs,
    indicators,
  };
}
