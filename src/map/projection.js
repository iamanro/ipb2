// The map's projections and GeoJSON options, shared by every map file.

export const MAP_PROJECTION = 'EPSG:3857';

/** Amplifier text on map symbols; the symbols' light outline carries it on dark imagery. */
export const MAP_SYMBOL_INK = '#1b1b1b';
export const DATA_PROJECTION = 'EPSG:4326';
export const GEOJSON_OPTIONS = {
  featureProjection: MAP_PROJECTION,
  dataProjection: DATA_PROJECTION,
};
export const DRAW_GEOMETRY_TYPE = { point: 'Point', line: 'LineString', polygon: 'Polygon' };
