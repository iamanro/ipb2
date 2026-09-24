import { describe, expect, test } from 'vitest';

import { NO_GO, SLOW_GO, coverClass } from './landcover.js';

describe('coverClass', () => {
  test('rivers and canals block movement, but mapped streams only restrict it', () => {
    // Scoring every stream NO-GO cut dense stream networks into cells no
    // mobility corridor could cross (no 250 m avenue anywhere in Libavá).
    expect(coverClass('waterway', { class: 'river' })).toBe(NO_GO);
    expect(coverClass('waterway', { class: 'canal' })).toBe(NO_GO);
    expect(coverClass('waterway', { class: 'stream' })).toBe(SLOW_GO);
    expect(coverClass('waterway', { class: 'ditch' })).toBeNull();
  });

  test('a military landuse area is administrative, not an obstacle', () => {
    expect(coverClass('landuse', { class: 'military' })).toBeNull();
  });
});
