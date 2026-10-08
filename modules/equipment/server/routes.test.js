import { describe, expect, test } from 'vitest';

import { cardsParams } from './routes.ts';

describe('cardsParams (POST /api/equipment/cards body)', () => {
  test('rejects a body that is not a JSON object with a 400, not a crash', () => {
    for (const body of [null, [1, 2], 'text', 42]) {
      expect(() => cardsParams(body)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });

  test('clamps paging into the served range and falls back on junk', () => {
    expect(cardsParams({ limit: 99999, offset: -5 })).toMatchObject({ limit: 200, offset: 0 });
    expect(cardsParams({ limit: 0 })).toMatchObject({ limit: 1 });
    expect(cardsParams({ limit: 'abc', offset: 'x' })).toMatchObject({ limit: 100, offset: 0 });
  });

  test('keeps only string text and array filters, one list per known kind', () => {
    const params = cardsParams({
      text: 5,
      filters: { domain: 'air', origin: ['ru', 7], proliferation: null, bogus: ['x'] },
    });
    expect(params.text).toBeNull();
    expect(params.filters).toEqual({ domain: [], origin: ['ru', '7'], proliferation: [] });
  });
});
