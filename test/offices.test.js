const test = require('node:test');
const assert = require('node:assert');
const o = require('../lib/offices');

// The seed, as migration 049 stores it.
const counties = [
  { county: 'montgomery', time_zone: 'America/Chicago',
    assignment_rule: "Test only at the office you're assigned to. Check with your officer if you're not sure.",
    maps_query: 'Montgomery County Community Supervision and Corrections Department, Conroe, TX',
    updated_at: '2026-09-03T10:00:00Z' },
  { county: 'ftbend', time_zone: 'America/Chicago', assignment_rule: null,
    maps_query: 'Fort Bend County Community Supervision and Corrections Department, Missouri City, TX',
    updated_at: '2026-09-03T09:00:00Z' },
];
const conroe = {
  id: 'conroe', county: 'montgomery', name: 'RMS Conroe Office',
  street: '310 East Davis Street, Suite 100', city_line: 'Conroe, TX 77301',
  phone: '(936) 207-4223', sort_order: 0, updated_at: '2026-09-03T11:00:00Z',
  hours: { monday: ['08:00-17:45'], saturday: ['08:00-15:00'] },
  notes: ["Saturday: Conroe only, and only if you're required to test that day."],
};
const newCaney = {
  id: 'new-caney', county: 'montgomery', name: 'New Caney Office',
  street: '21134 US Hwy 59', city_line: 'New Caney, TX 77357',
  phone: '(281) 577-8996', sort_order: 1, updated_at: '2026-09-03T08:00:00Z',
  hours: { tuesday: ['07:00-11:00', '12:00-15:45'] },
  notes: ['Closed Mondays.', 'Closed 11:00 AM – 12:00 PM for lunch.'],
};

test('hasDirectory comes from having offices, and Fort Bend keeps the Maps fallback', function() {
  const d = o.shapeDirectory(counties, [conroe, newCaney]);
  assert.strictEqual(d.counties.montgomery.hasDirectory, true);
  assert.strictEqual(d.counties.montgomery.offices.length, 2);
  // The property that must survive: no verified rows means no directory, and
  // the client falls back to a Maps SEARCH rather than a pinned address.
  assert.strictEqual(d.counties.ftbend.hasDirectory, false);
  assert.deepStrictEqual(d.counties.ftbend.offices, []);
  assert.match(d.counties.ftbend.mapsQuery, /Missouri City, TX$/);
});

test('a retired (inactive) office is absent, and can empty a directory', function() {
  // The route selects is_active only; if that leaves a county with none, the
  // county honestly reports no directory rather than a stale address.
  const d = o.shapeDirectory(counties, []);
  assert.strictEqual(d.counties.montgomery.hasDirectory, false);
  assert.deepStrictEqual(d.counties.montgomery.offices, []);
});

test('offices come back in sort_order, and carry the app-ready shape', function() {
  const d = o.shapeDirectory(counties, [newCaney, conroe]); // deliberately reversed
  const ids = d.counties.montgomery.offices.map(function(x) { return x.id; });
  assert.deepStrictEqual(ids, ['conroe', 'new-caney']);
  const c = d.counties.montgomery.offices[0];
  assert.strictEqual(c.cityLine, 'Conroe, TX 77301');
  assert.deepStrictEqual(c.hours.saturday, ['08:00-15:00']);
  // Lunch closure survives as two spans; the en dash in the note is intact.
  assert.deepStrictEqual(d.counties.montgomery.offices[1].hours.tuesday,
    ['07:00-11:00', '12:00-15:45']);
  assert.ok(d.counties.montgomery.offices[1].notes[1].includes('–'));
});

test('closed is expressed by absence, never an empty array', function() {
  // An empty array could read as "open, hours unknown". A day with no usable
  // span is dropped so the client's "missing weekday = closed" rule holds.
  const h = o.cleanHours({ monday: [], tuesday: ['bogus'], wednesday: ['09:00-17:00'] });
  assert.strictEqual('monday' in h, false);
  assert.strictEqual('tuesday' in h, false);
  assert.deepStrictEqual(h.wednesday, ['09:00-17:00']);
});

test('junk in the hours column cannot reach the client', function() {
  const h = o.cleanHours({ funday: ['09:00-17:00'], monday: ['25:00-26:00'], tuesday: '09:00-17:00' });
  assert.deepStrictEqual(h, {});
});

test('asOf is the newest updated_at across counties and offices', function() {
  const d = o.shapeDirectory(counties, [conroe, newCaney]);
  assert.strictEqual(d.asOf, '2026-09-03T11:00:00.000Z'); // conroe's, the latest
});
