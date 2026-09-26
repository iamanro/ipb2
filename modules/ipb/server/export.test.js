import { describe, expect, test } from 'vitest';

import { sanitizeFilename, toGeoJson, toKml } from './export.js';

const STUDY = { name: 'Op <Griffin> "Alpha" & Bravo' };

const FEATURES = [
  {
    id: 1,
    layer: 'aoi',
    kind: 'polygon',
    label: 'Area of interest',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [17.4, 49.6],
          [17.4, 49.7],
          [17.5, 49.7],
          [17.4, 49.6],
        ],
      ],
    },
    properties: {},
  },
  {
    id: 2,
    layer: 'unit',
    kind: 'symbol',
    label: 'Recon <platoon> & "friends"',
    geometry: { type: 'Point', coordinates: [17.45, 49.65] },
    properties: { sidc: '30031000001211000000', coa_id: 5 },
  },
  {
    id: 3,
    layer: 'range-ring',
    kind: 'range-ring',
    label: '',
    geometry: { type: 'Point', coordinates: [17.46, 49.66] },
    properties: { radii: [1000, 2000] },
  },
];

describe('toGeoJson', () => {
  test('is a valid RFC 7946 FeatureCollection with layer/kind/label folded into properties', () => {
    const geojson = toGeoJson(STUDY, FEATURES);
    // Round-trips through JSON exactly like a client parsing the export body would.
    const parsed = JSON.parse(JSON.stringify(geojson));
    expect(parsed.type).toBe('FeatureCollection');
    expect(parsed.crs).toBeUndefined(); // RFC 7946 default (WGS84); no crs member.
    expect(parsed.features).toHaveLength(3);
    expect(parsed.features[1]).toMatchObject({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [17.45, 49.65] },
      properties: {
        layer: 'unit',
        kind: 'symbol',
        label: 'Recon <platoon> & "friends"',
        sidc: '30031000001211000000',
        coa_id: 5,
      },
    });
  });
});

describe('toKml', () => {
  const kml = toKml(STUDY, FEATURES);

  test('declares KML 2.2 and is well-formed enough for a minimal tag-balance check', () => {
    expect(kml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(kml).toContain('<kml xmlns="http://www.opengis.net/kml/2.2">');
    // Every opening element tag has a matching closing tag, in a well-formed document.
    const opens = [...kml.matchAll(/<([A-Za-z]+)(?:\s[^>]*)?>/g)].map((m) => m[1]);
    const closes = [...kml.matchAll(/<\/([A-Za-z]+)>/g)].map((m) => m[1]);
    const selfClosing = [...kml.matchAll(/<([A-Za-z]+)[^>]*\/>/g)].map((m) => m[1]);
    const opensCount = {};
    for (const tag of opens) opensCount[tag] = (opensCount[tag] || 0) + 1;
    for (const tag of selfClosing) opensCount[tag] -= 1;
    const closesCount = {};
    for (const tag of closes) closesCount[tag] = (closesCount[tag] || 0) + 1;
    expect(closesCount).toEqual(opensCount);
  });

  test('groups placemarks into one Folder per layer, in first-seen order', () => {
    const folderNames = [...kml.matchAll(/<Folder><name>([^<]*)<\/name>/g)].map((m) => m[1]);
    expect(folderNames).toEqual(['aoi', 'unit', 'range-ring']);
  });

  test('escapes <, & and " in labels and study/folder names', () => {
    expect(kml).toContain('<name>Op &lt;Griffin&gt; &quot;Alpha&quot; &amp; Bravo</name>');
    expect(kml).toContain('<name>Recon &lt;platoon&gt; &amp; &quot;friends&quot;</name>');
    // No raw '<' or '"' slipped through unescaped anywhere in the document.
    expect(kml.replace(/<[^>]*>/g, '')).not.toMatch(/["<]/);
  });

  test('carries sidc, coa_id and radii in ExtendedData', () => {
    expect(kml).toContain('<Data name="sidc"><value>30031000001211000000</value></Data>');
    expect(kml).toContain('<Data name="coa_id"><value>5</value></Data>');
    expect(kml).toContain('<Data name="radii"><value>1000,2000</value></Data>');
  });

  test('a feature with no label falls back to its layer name, not an empty tag', () => {
    expect(kml).toContain('<name>range-ring</name>');
  });
});

describe('sanitizeFilename', () => {
  test('strips unsafe characters and collapses whitespace to dashes', () => {
    expect(sanitizeFilename('Op Griffin: Phase 1 / Draft')).toBe('Op-Griffin-Phase-1-Draft');
  });

  test('falls back to a default for an empty or fully-unsafe name', () => {
    expect(sanitizeFilename('')).toBe('study');
    expect(sanitizeFilename('###')).toBe('study');
    expect(sanitizeFilename(null)).toBe('study');
  });
});
