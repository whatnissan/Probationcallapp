const test = require('node:test');
const assert = require('node:assert');
const { spacingSecondsFrom, cohortOrder, cohortDelayMs, maxCohortSize, staggerWindowMinutes, DEFAULT_SPACING_SECONDS } = require('../lib/stagger');

test('spacing: env value wins, anything unusable falls back to 45', () => {
  assert.equal(DEFAULT_SPACING_SECONDS, 45);
  assert.equal(spacingSecondsFrom('20'), 20);
  assert.equal(spacingSecondsFrom('45'), 45);
  assert.equal(spacingSecondsFrom(undefined), 45);
  assert.equal(spacingSecondsFrom(''), 45);
  assert.equal(spacingSecondsFrom('0'), 45);
  assert.equal(spacingSecondsFrom('-5'), 45);
  assert.equal(spacingSecondsFrom('abc'), 45);
});

test('cohort order: creation time first, id as the tie-break, input untouched', () => {
  const m = [
    { user_id: 'c', created_at: '2026-03-01T00:00:00Z' },
    { user_id: 'a', created_at: '2026-01-30T00:00:00Z' },
    { user_id: 'b', created_at: '2026-01-30T00:00:00Z' }
  ];
  const copy = m.slice();
  assert.deepEqual(cohortOrder(m).map(x => x.user_id), ['a', 'b', 'c']);
  assert.deepEqual(m, copy);
});

test('cohort delay: first at +0, then spacing apart; joining moves nobody', () => {
  const m = [
    { user_id: 'rocky', created_at: '2026-01-01T00:00:00Z' },
    { user_id: 'tawn', created_at: '2026-01-15T00:00:00Z' },
    { user_id: 'cmc', created_at: '2026-01-30T00:00:00Z' }
  ];
  assert.equal(cohortDelayMs('rocky', m, 45), 0);
  assert.equal(cohortDelayMs('tawn', m, 45), 45000);
  assert.equal(cohortDelayMs('cmc', m, 45), 90000);
  const joined = m.concat([{ user_id: 'new', created_at: '2026-09-17T00:00:00Z' }]);
  assert.equal(cohortDelayMs('cmc', joined, 45), 90000, 'existing member keeps its slot');
  assert.equal(cohortDelayMs('new', joined, 45), 135000);
  assert.equal(cohortDelayMs('cmc', m, 20), 40000);
});

test('cohort delay: a user missing from the list dials at +0, not never', () => {
  assert.equal(cohortDelayMs('ghost', [{ user_id: 'x', created_at: '2026-01-01T00:00:00Z' }], 45), 0);
  assert.equal(cohortDelayMs('ghost', [], 45), 0);
});

test('max cohort: counts users per call time, ignores Fort Bend', () => {
  const s = [
    { hour: 6, minute: 30, county: 'montgomery' },
    { hour: 6, minute: 30, county: 'montgomery' },
    { hour: 6, minute: 30, county: 'montgomery' },
    { hour: 6, minute: 0, county: 'montgomery' },
    { hour: 6, minute: 0, county: 'ftbend' },
    { hour: 6, minute: 0, county: 'ftbend' },
    { hour: 6, minute: 0, county: 'ftbend' },
    { hour: 6, minute: 0, county: 'ftbend' }
  ];
  assert.equal(maxCohortSize(s), 3);
  assert.equal(maxCohortSize([]), 0);
  assert.equal(maxCohortSize(null), 0);
});

test('window minutes: derived from the busiest cohort, never below the floor', () => {
  const three = [{ hour: 6, minute: 30 }, { hour: 6, minute: 30 }, { hour: 6, minute: 30 }];
  assert.equal(staggerWindowMinutes(three, 45, 15), 15, 'a 90 s tail stays under the 15-minute floor');
  assert.equal(staggerWindowMinutes(three, 45, 0), 2, '90 s rounds up to 2 whole minutes');
  const forty = Array.from({ length: 40 }, () => ({ hour: 6, minute: 0 }));
  assert.equal(staggerWindowMinutes(forty, 45, 15), 30, '39 × 45 s = 29m15s → 30');
  assert.equal(staggerWindowMinutes(forty, 20, 15), 15, '39 × 20 s = 13 min, floor wins');
  assert.equal(staggerWindowMinutes([], 45, 15), 15);
});
