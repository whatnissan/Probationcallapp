// §4.18 office directory — the pure shaping. Rows in, contract payload out.
//
// THE PROPERTY THIS FILE EXISTS TO PROTECT: `hasDirectory` is derived from
// whether a county actually has active office rows, and NOTHING ELSE. A
// county with none has no verified directory, and the client falls back to
// a Maps SEARCH instead of pinning an address it cannot vouch for. That
// rule predates this endpoint (OfficeDirectory.swift: "the app doesn't
// vouch for a building it can't verify, and a wrong address sends someone
// on probation to the wrong place"), and serving a directory must not be
// what quietly ends it. Fort Bend has a county row and no offices, on
// purpose, until its form arrives and someone verifies the addresses.
//
// So there is no `has_directory` column to get out of sync: absence IS the
// signal.

// Weekday keys we will emit, in week order. Anything else in the stored
// hours object is dropped rather than forwarded — the client's Weekday enum
// cannot decode a key it has never heard of, and a stray key is a data
// entry mistake, not a new day of the week.
var WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// "HH:mm-HH:mm", the exact shape TestingOffice.OpenSpan already parses.
var SPAN = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

function cleanHours(raw) {
  var out = {};
  if (!raw || typeof raw !== 'object') return out;
  WEEKDAYS.forEach(function(day) {
    var spans = raw[day];
    if (!Array.isArray(spans)) return;
    var valid = spans.filter(function(s) { return typeof s === 'string' && SPAN.test(s); });
    // A day present but with no usable span is CLOSED, and closed is
    // expressed by absence — never by an empty array, which a client could
    // reasonably read as "open, hours unknown".
    if (valid.length) out[day] = valid;
  });
  return out;
}

function cleanNotes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(function(n) { return typeof n === 'string' && n.trim(); });
}

function shapeOffice(row) {
  return {
    id: row.id,
    name: row.name,
    street: row.street,
    cityLine: row.city_line,
    phone: row.phone || null,
    hours: cleanHours(row.hours),
    notes: cleanNotes(row.notes)
  };
}

// countyRows: office_counties. officeRows: offices, ACTIVE ONLY — an
// inactive office is a retired one and must not appear, though its row is
// kept so the record that it existed survives.
function shapeDirectory(countyRows, officeRows) {
  var byCounty = {};
  (officeRows || []).forEach(function(r) {
    (byCounty[r.county] = byCounty[r.county] || []).push(r);
  });

  var counties = {};
  var newest = null;
  function note(ts) {
    if (!ts) return;
    var t = Date.parse(ts);
    if (!isNaN(t) && (newest === null || t > newest)) newest = t;
  }

  (countyRows || []).forEach(function(c) {
    note(c.updated_at);
    var rows = (byCounty[c.county] || []).slice().sort(function(a, b) {
      return (a.sort_order - b.sort_order) || String(a.id).localeCompare(String(b.id));
    });
    rows.forEach(function(r) { note(r.updated_at); });
    counties[c.county] = {
      hasDirectory: rows.length > 0,
      timeZone: c.time_zone,
      assignmentRule: c.assignment_rule || null,
      mapsQuery: c.maps_query || null,
      offices: rows.map(shapeOffice)
    };
  });

  return { counties: counties, asOf: newest === null ? null : new Date(newest).toISOString() };
}

module.exports = { shapeDirectory: shapeDirectory, cleanHours: cleanHours, WEEKDAYS: WEEKDAYS };
