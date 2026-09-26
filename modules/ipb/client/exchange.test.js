import { describe, expect, test } from 'vitest';

import { toGeoJson, toKml } from '../server/export.js';
import {
  DEFAULT_CLASSIFICATION,
  FOREIGN_TARGET_LAYERS,
  MAX_BULK_FEATURES,
  buildImportPlan,
  classifyImportItem,
  detectFormat,
  parseGeoJson,
  parseImportItems,
  parseKml,
} from './exchange.js';

describe('detectFormat', () => {
  test('by extension', () => {
    expect(detectFormat('study.kml', '')).toBe('kml');
    expect(detectFormat('study.geojson', '')).toBe('geojson');
    expect(detectFormat('study.json', '')).toBe('geojson');
  });

  test('falls back to sniffing an XML/kml prologue when the extension is unknown', () => {
    expect(detectFormat('upload', '<?xml version="1.0"?><kml></kml>')).toBe('kml');
    expect(detectFormat('upload', '{"type":"FeatureCollection","features":[]}')).toBe('geojson');
  });
});

describe('parseGeoJson', () => {
  test('reads a FeatureCollection, folding properties through', () => {
    const items = parseGeoJson(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [17.5, 49.7] },
            properties: { layer: 'note', kind: 'point', label: 'OP 1' },
          },
        ],
      }),
    );
    expect(items).toEqual([
      {
        label: 'OP 1',
        geometry: { type: 'Point', coordinates: [17.5, 49.7] },
        properties: { layer: 'note', kind: 'point', label: 'OP 1' },
      },
    ]);
  });

  test('accepts a bare Feature and falls back to properties.name for the label', () => {
    const items = parseGeoJson(
      JSON.stringify({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { name: 'From QGIS' },
      }),
    );
    expect(items).toEqual([
      {
        label: 'From QGIS',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { name: 'From QGIS' },
      },
    ]);
  });

  test('skips a Feature with no geometry', () => {
    expect(
      parseGeoJson(
        JSON.stringify({
          type: 'FeatureCollection',
          features: [{ type: 'Feature', properties: {} }],
        }),
      ),
    ).toEqual([]);
  });
});

describe('parseKml', () => {
  const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Test</name>
<Folder><name>note</name>
<Placemark><name>OP 1</name><Point><coordinates>17.5,49.7</coordinates></Point></Placemark>
</Folder>
<Folder><name>graphic</name>
<Placemark><name>PL Whiskey</name><ExtendedData><Data name="graphic"><value>phase-line</value></Data></ExtendedData><LineString><coordinates>17.4,49.6 17.5,49.7</coordinates></LineString></Placemark>
</Folder>
</Document></kml>`;

  test('reads Placemarks grouped by Folder, carrying the Folder name as folderLayer', () => {
    const items = parseKml(KML);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      label: 'OP 1',
      geometry: { type: 'Point', coordinates: [17.5, 49.7] },
      properties: {},
      folderLayer: 'note',
    });
    expect(items[1]).toMatchObject({
      label: 'PL Whiskey',
      geometry: {
        type: 'LineString',
        coordinates: [
          [17.4, 49.6],
          [17.5, 49.7],
        ],
      },
      properties: { graphic: 'phase-line' },
      folderLayer: 'graphic',
    });
  });

  test('reads a Polygon with a hole', () => {
    const kml = `<Placemark><name>Ring</name><Polygon>
      <outerBoundaryIs><LinearRing><coordinates>0,0 0,10 10,10 10,0 0,0</coordinates></LinearRing></outerBoundaryIs>
      <innerBoundaryIs><LinearRing><coordinates>4,4 4,6 6,6 6,4 4,4</coordinates></LinearRing></innerBoundaryIs>
    </Polygon></Placemark>`;
    const [item] = parseKml(kml);
    expect(item.geometry.type).toBe('Polygon');
    expect(item.geometry.coordinates).toHaveLength(2);
    expect(item.geometry.coordinates[0][0]).toEqual([0, 0]);
    expect(item.geometry.coordinates[1][0]).toEqual([4, 4]);
  });

  test('reads a MultiGeometry of LineStrings as MultiLineString', () => {
    const kml = `<Placemark><name>Multi</name><MultiGeometry>
      <LineString><coordinates>0,0 1,1</coordinates></LineString>
      <LineString><coordinates>2,2 3,3</coordinates></LineString>
    </MultiGeometry></Placemark>`;
    const [item] = parseKml(kml);
    expect(item.geometry).toEqual({
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [2, 2],
          [3, 3],
        ],
      ],
    });
  });

  test('unescapes XML entities in names', () => {
    const kml = `<Placemark><name>Op &lt;Griffin&gt; &amp; &quot;Bravo&quot;</name><Point><coordinates>0,0</coordinates></Point></Placemark>`;
    expect(parseKml(kml)[0].label).toBe('Op <Griffin> & "Bravo"');
  });

  test('falls back to flat Placemarks when there is no Folder convention', () => {
    const kml = `<kml><Document><Placemark><name>Loose</name><Point><coordinates>1,1</coordinates></Point></Placemark></Document></kml>`;
    const [item] = parseKml(kml);
    expect(item.folderLayer).toBeUndefined();
  });
});

describe('classifyImportItem', () => {
  test('a real layer with an explicit valid kind is native', () => {
    expect(
      classifyImportItem({
        geometry: { type: 'Point' },
        properties: { layer: 'note', kind: 'point' },
      }),
    ).toEqual({ native: true, layer: 'note', kind: 'point' });
  });

  test('an unknown layer is foreign, even with a plausible kind', () => {
    expect(
      classifyImportItem({
        geometry: { type: 'Point' },
        properties: { layer: 'poi', kind: 'point' },
      }),
    ).toEqual({
      native: false,
      layer: null,
      kind: null,
    });
  });

  test('a KML round trip infers kind from graphic/radii/sidc/geometry when the Folder names a real layer', () => {
    expect(
      classifyImportItem({
        geometry: { type: 'LineString' },
        properties: { graphic: 'boundary' },
        folderLayer: 'graphic',
      }),
    ).toEqual({ native: true, layer: 'graphic', kind: 'graphic' });
    expect(
      classifyImportItem({
        geometry: { type: 'Point' },
        properties: { radii: [1000] },
        folderLayer: 'range-ring',
      }),
    ).toEqual({ native: true, layer: 'range-ring', kind: 'range-ring' });
    expect(
      classifyImportItem({
        geometry: { type: 'Point' },
        properties: { sidc: '3' },
        folderLayer: 'unit',
      }),
    ).toEqual({ native: true, layer: 'unit', kind: 'symbol' });
    expect(
      classifyImportItem({
        geometry: { type: 'Polygon' },
        properties: {},
        folderLayer: 'key-terrain',
      }),
    ).toEqual({
      native: true,
      layer: 'key-terrain',
      kind: 'polygon',
    });
  });
});

describe('buildImportPlan', () => {
  test('counts by geometry type over every item, before skipping', () => {
    const { counts } = buildImportPlan([
      { geometry: { type: 'Point' }, properties: {} },
      { geometry: { type: 'Point' }, properties: {} },
      { geometry: { type: 'GeometryCollection' }, properties: {} },
    ]);
    expect(counts).toEqual({ Point: 2, GeometryCollection: 1 });
  });

  test('skips unsupported and missing geometry with a reason', () => {
    const { skipped, toCreate } = buildImportPlan([
      { label: 'No geom', geometry: null, properties: {} },
      { label: 'Collection', geometry: { type: 'GeometryCollection' }, properties: {} },
    ]);
    expect(toCreate).toEqual([]);
    expect(skipped).toEqual([
      { label: 'No geom', reason: 'No geometry' },
      { label: 'Collection', reason: 'Unsupported geometry: GeometryCollection' },
    ]);
  });

  test('a native item keeps its layer/kind and drops layer/kind/label from properties', () => {
    const { toCreate } = buildImportPlan([
      {
        label: 'OP 1',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { layer: 'note', kind: 'point', label: 'OP 1', extra: 'x' },
      },
    ]);
    expect(toCreate).toEqual([
      {
        layer: 'note',
        kind: 'point',
        label: 'OP 1',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { extra: 'x' },
      },
    ]);
  });

  test('a bad native graphic (wrong geometry for its type) is skipped with a reason, not fatal to the batch', () => {
    const { skipped, toCreate } = buildImportPlan([
      {
        label: 'Bad PL',
        geometry: { type: 'Polygon', coordinates: [] },
        properties: { layer: 'graphic', kind: 'graphic', graphic: 'phase-line' },
      },
      {
        label: 'Good OP',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { layer: 'note', kind: 'point' },
      },
    ]);
    expect(skipped).toEqual([{ label: 'Bad PL', reason: 'graphic "phase-line" must be a line' }]);
    expect(toCreate).toHaveLength(1);
  });

  test('foreign data needs a targetLayer, and is filed under it with kind from geometry', () => {
    const item = {
      label: 'POI',
      geometry: { type: 'Point', coordinates: [1, 2] },
      properties: { name: 'POI' },
    };
    expect(buildImportPlan([item], {}).skipped).toEqual([
      { label: 'POI', reason: 'No target layer chosen for this foreign feature' },
    ]);
    const { toCreate } = buildImportPlan([item], { targetLayer: 'key-terrain' });
    expect(toCreate).toEqual([
      {
        layer: 'key-terrain',
        kind: 'point',
        label: 'POI',
        geometry: item.geometry,
        properties: {},
      },
    ]);
  });

  test('FOREIGN_TARGET_LAYERS lists the four documented choices', () => {
    expect(FOREIGN_TARGET_LAYERS.map((entry) => entry.id)).toEqual([
      'note',
      'obstacle',
      'nai',
      'key-terrain',
    ]);
  });
});

describe("round-trip through the server's own export (modules/ipb/server/export.js)", () => {
  const STUDY = { name: 'Round Trip Study' };
  const FEATURES = [
    {
      id: 1,
      layer: 'note',
      kind: 'point',
      label: 'OP 1',
      geometry: { type: 'Point', coordinates: [17.5, 49.7] },
      properties: {},
    },
    {
      id: 2,
      layer: 'obstacle',
      kind: 'line',
      label: 'Wire obstacle',
      geometry: {
        type: 'LineString',
        coordinates: [
          [17.4, 49.6],
          [17.45, 49.65],
        ],
      },
      properties: {},
    },
    {
      id: 3,
      layer: 'key-terrain',
      kind: 'polygon',
      label: 'Hill 214',
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
      id: 4,
      layer: 'unit',
      kind: 'symbol',
      label: 'Recon platoon',
      geometry: { type: 'Point', coordinates: [17.45, 49.65] },
      properties: { sidc: '30031000001211000000', coa_id: 5 },
    },
    {
      id: 5,
      layer: 'graphic',
      kind: 'graphic',
      label: 'PL Whiskey',
      geometry: {
        type: 'LineString',
        coordinates: [
          [17.4, 49.6],
          [17.5, 49.7],
        ],
      },
      properties: { graphic: 'phase-line', affiliation: 'friendly', name: 'PL Whiskey' },
    },
    {
      id: 6,
      layer: 'range-ring',
      kind: 'range-ring',
      label: 'BM-21 range',
      geometry: { type: 'Point', coordinates: [17.46, 49.66] },
      properties: { radii: [10000, 20000] },
    },
  ];

  test('GeoJSON export imports back with nothing skipped, same layer/kind/geometry', () => {
    const geojson = toGeoJson(STUDY, FEATURES);
    const items = parseImportItems(JSON.stringify(geojson), 'export.geojson');
    const { toCreate, skipped } = buildImportPlan(items, {});
    expect(skipped).toEqual([]);
    expect(toCreate).toHaveLength(FEATURES.length);
    toCreate.forEach((created, index) => {
      expect(created.layer).toBe(FEATURES[index].layer);
      expect(created.kind).toBe(FEATURES[index].kind);
      expect(created.geometry).toEqual(FEATURES[index].geometry);
      expect(created.label).toBe(FEATURES[index].label);
    });
    expect(toCreate[3].properties).toEqual({ sidc: '30031000001211000000', coa_id: 5 });
    expect(toCreate[5].properties).toEqual({ radii: [10000, 20000] });
  });

  test('KML export imports back with nothing skipped, same layer/kind/geometry', () => {
    const kml = toKml(STUDY, FEATURES);
    const items = parseImportItems(kml, 'export.kml');
    const { toCreate, skipped } = buildImportPlan(items, {});
    expect(skipped).toEqual([]);
    expect(toCreate).toHaveLength(FEATURES.length);
    toCreate.forEach((created, index) => {
      expect(created.layer).toBe(FEATURES[index].layer);
      expect(created.kind).toBe(FEATURES[index].kind);
      expect(created.geometry).toEqual(FEATURES[index].geometry);
      expect(created.label).toBe(FEATURES[index].label);
    });
    // KML's ExtendedData only carries sidc/graphic/coa_id/radii, not the
    // graphic's "name" or the unit's own label duplication — those two are
    // the only properties round trips through KML, and it recovers them
    // typed (coa_id a number, radii a number array), not as raw strings.
    expect(toCreate[3].properties).toEqual({ sidc: '30031000001211000000', coa_id: 5 });
    expect(toCreate[5].properties).toEqual({ radii: [10000, 20000] });
  });

  test('exceeding MAX_BULK_FEATURES is a plan-level fact the caller can check before submitting', () => {
    const items = Array.from({ length: MAX_BULK_FEATURES + 1 }, (_, index) => ({
      label: `pt-${index}`,
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: {},
    }));
    const { toCreate } = buildImportPlan(items, { targetLayer: 'note' });
    expect(toCreate.length).toBeGreaterThan(MAX_BULK_FEATURES);
  });
});

describe('DEFAULT_CLASSIFICATION', () => {
  test('matches the server default', () => {
    expect(DEFAULT_CLASSIFICATION).toBe('UNCLASSIFIED // EXERCISE');
  });
});
