import { expect, test } from 'vitest';

import { requiredRole, roleAtLeast } from './access.js';

test('roleAtLeast ranks observer < analyst < collection-manager < game-master < admin', () => {
  expect(roleAtLeast('observer', 'observer')).toBe(true);
  expect(roleAtLeast('observer', 'analyst')).toBe(false);
  expect(roleAtLeast('analyst', 'observer')).toBe(true);
  expect(roleAtLeast('collection-manager', 'analyst')).toBe(true);
  expect(roleAtLeast('analyst', 'collection-manager')).toBe(false);
  expect(roleAtLeast('game-master', 'game-master')).toBe(true);
  expect(roleAtLeast('collection-manager', 'game-master')).toBe(false);
  expect(roleAtLeast('admin', 'game-master')).toBe(true);
  expect(roleAtLeast('game-master', 'admin')).toBe(false);
  expect(roleAtLeast('admin', 'admin')).toBe(true);
});

test('roleAtLeast rejects an unknown role', () => {
  expect(() => roleAtLeast('root', 'observer')).toThrow('Unknown role');
});

test('every GET is observer, whatever the module or route', () => {
  expect(requiredRole('ipb', 'GET', 'studies')).toBe('observer');
  expect(requiredRole('exercise', 'GET', 'clock')).toBe('observer');
  expect(requiredRole('exercise', 'GET', 'collectors')).toBe('observer');
  expect(requiredRole('equipment', 'GET', 'cards')).toBe('observer');
  expect(requiredRole('nonexistent-module', 'GET', 'whatever')).toBe('observer');
  expect(requiredRole('ipb', 'HEAD', 'studies')).toBe('observer');
});

test('unknown routes and modules default a mutation to analyst', () => {
  expect(requiredRole('exercise', 'POST', 'something-new')).toBe('analyst');
  expect(requiredRole('made-up-module', 'DELETE', 'whatever/5')).toBe('analyst');
});

// -- ipb: every existing mutating route, plus the wave-2 routes named in the plan --
test.each([
  ['POST', 'studies'],
  ['PATCH', 'studies/1'],
  ['DELETE', 'studies/1'],
  ['POST', 'studies/1/features'],
  ['POST', 'studies/1/threats'],
  ['POST', 'studies/1/coas'],
  ['POST', 'studies/1/events'],
  ['POST', 'studies/1/analyses'],
  ['POST', 'studies/1/layers'],
  ['POST', 'studies/1/points'],
  ['PATCH', 'features/1'],
  ['DELETE', 'features/1'],
  ['DELETE', 'analyses/1'],
  ['POST', 'features/1/reorder'],
  // planned wave-2 routes (C6)
  ['POST', 'studies/1/phases'],
  ['PATCH', 'phases/1'],
  ['DELETE', 'phases/1'],
  ['POST', 'studies/1/decision-points'],
  ['PATCH', 'decision-points/1'],
  ['DELETE', 'decision-points/1'],
  ['POST', 'studies/1/civil-considerations'],
  ['PATCH', 'civil-considerations/1'],
  ['POST', 'studies/1/features/bulk'],
])('ipb %s %s needs analyst', (method, route) => {
  expect(requiredRole('ipb', method, route)).toBe('analyst');
});

// -- exercise: game-master routes (the scenario itself) --
test.each([
  ['PATCH', 'clock'],
  ['POST', 'scenario-events'],
  ['POST', 'scenario-events/1/cancel'],
  ['POST', 'scenario-events/1/fire'],
  ['POST', 'scenario-tick'],
  ['POST', 'scenarios'],
  ['POST', 'scenarios/example'],
  ['PATCH', 'scenarios/1'],
  ['DELETE', 'scenarios/1'],
  ['POST', 'scenarios/1/duplicate'],
  ['POST', 'scenarios/1/countries'],
  ['PATCH', 'scenario-countries/1'],
  ['DELETE', 'scenario-countries/1'],
  ['POST', 'scenarios/1/places'],
  ['PATCH', 'scenario-places/1'],
  ['DELETE', 'scenario-places/1'],
  ['POST', 'roster'],
  ['DELETE', 'roster/1'],
])('exercise %s %s needs game-master', (method, route) => {
  expect(requiredRole('exercise', method, route)).toBe('game-master');
});

// -- exercise: collection-manager routes (planned, C7) --
test.each([
  ['POST', 'collectors'],
  ['PATCH', 'collectors/1'],
  ['DELETE', 'collectors/1'],
  ['POST', 'taskings'],
  ['PATCH', 'taskings/1'],
  ['DELETE', 'taskings/1'],
])('exercise %s %s needs collection-manager', (method, route) => {
  expect(requiredRole('exercise', method, route)).toBe('collection-manager');
});

// -- exercise: every other existing mutating route, plus planned tracks/intsums (analyst) --
test.each([
  ['POST', 'requirements'],
  ['PATCH', 'requirements/1'],
  ['DELETE', 'requirements/1'],
  ['POST', 'import/ipb'],
  ['POST', 'requirements/1/sirs'],
  ['PATCH', 'sirs/1'],
  ['DELETE', 'sirs/1'],
  ['POST', 'sirs/1/indicators'],
  ['PATCH', 'indicators/1'],
  ['DELETE', 'indicators/1'],
  ['POST', 'reports'],
  ['PATCH', 'reports/1'],
  ['DELETE', 'reports/1'],
  ['POST', 'reports/1/links'],
  ['DELETE', 'links/1'],
  ['POST', 'rfis'],
  ['PATCH', 'rfis/1'],
  ['DELETE', 'rfis/1'],
  ['POST', 'rfis/1/transition'],
  // planned wave-2 routes (C7)
  ['POST', 'tracks'],
  ['PATCH', 'tracks/1'],
  ['DELETE', 'tracks/1'],
  ['POST', 'tracks/1/positions'],
  ['POST', 'intsums'],
  ['PATCH', 'intsums/1'],
])('exercise %s %s needs analyst', (method, route) => {
  expect(requiredRole('exercise', method, route)).toBe('analyst');
});

// -- orbat: every existing mutating route --
test.each([
  ['POST', 'orbats'],
  ['POST', 'orbats/import'],
  ['PATCH', 'orbats/1'],
  ['DELETE', 'orbats/1'],
  ['POST', 'orbats/1/units'],
  ['PATCH', 'units/1'],
  ['DELETE', 'units/1'],
  ['POST', 'units/1/duplicate'],
])('orbat %s %s needs analyst', (method, route) => {
  expect(requiredRole('orbat', method, route)).toBe('analyst');
});

// -- equipment: bookmarks mutate the analyst's own state; cards/ranges are reads via POST --
test.each([
  ['POST', 'bookmarks'],
  ['PATCH', 'bookmarks/1'],
  ['DELETE', 'bookmarks/1'],
])('equipment %s %s needs analyst', (method, route) => {
  expect(requiredRole('equipment', method, route)).toBe('analyst');
});

test.each([
  ['POST', 'cards'],
  ['POST', 'ranges'],
])('equipment %s %s reads at observer, not a mutation', (method, route) => {
  expect(requiredRole('equipment', method, route)).toBe('observer');
});

test('terrain POST extremes reads at observer; an unknown terrain POST stays at analyst', () => {
  expect(requiredRole('terrain', 'POST', 'extremes')).toBe('observer');
  expect(requiredRole('terrain', 'POST', 'something-new')).toBe('analyst');
});

test('exercise scenario-events is game-master even to read: injects stay hidden from the training audience', () => {
  expect(requiredRole('exercise', 'GET', 'scenario-events')).toBe('game-master');
  expect(requiredRole('exercise', 'HEAD', 'scenario-events')).toBe('game-master');
  expect(requiredRole('exercise', 'GET', 'scenario-events/1/cancel')).toBe('game-master');
  // A plain GET on an unrelated exercise route is unaffected.
  expect(requiredRole('exercise', 'GET', 'clock')).toBe('observer');
});
