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
    var offices = rows.map(shapeOffice);
    counties[c.county] = {
      hasDirectory: rows.length > 0,
      timeZone: c.time_zone,
      assignmentRule: c.assignment_rule || null,
      mapsQuery: c.maps_query || null,
      // §4.18 soleOffice (migration 055): the weekdays on which the county
      // restricts testing to ONE office. Resolved against the ACTIVE offices
      // just shaped, so a retired or closed building can never be named.
      soleOffice: cleanSoleOffice(c.sole_office, offices, c.county),
      offices: offices
    };
  });

  return { counties: counties, asOf: newest === null ? null : new Date(newest).toISOString() };
}

// {"saturday":"conroe"} in, {"saturday":"conroe"} out — but only for entries
// the server can stand behind. The named office must be one of the ACTIVE
// offices in this county AND must have hours on that weekday. Anything else
// is a data error (a restriction pointing at a closed or retired building),
// and is dropped from the response with a log line rather than sent: the
// client would compute a deadline from it, and there is no honest deadline
// at a closed door. Unknown weekday keys are dropped for the same reason the
// hours cleaner drops them. Never throws; junk in the column is {}.
function cleanSoleOffice(raw, offices, county) {
  var out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  var byId = {};
  (offices || []).forEach(function(o) { byId[String(o.id).toLowerCase()] = o; });
  WEEKDAYS.forEach(function(day) {
    if (!Object.prototype.hasOwnProperty.call(raw, day)) return;
    var id = raw[day];
    if (typeof id !== 'string' || !id.trim()) return;
    id = id.trim().toLowerCase();
    var office = byId[id];
    if (!office) {
      console.warn('[OFFICES] ' + county + '.sole_office.' + day + ' names "' + id + '", which is not an active office — dropped');
      return;
    }
    if (!office.hours || !office.hours[day] || !office.hours[day].length) {
      console.warn('[OFFICES] ' + county + '.sole_office.' + day + ' names "' + id + '", which has no hours on ' + day + ' — dropped');
      return;
    }
    out[day] = id;
  });
  return out;
}

module.exports = { shapeDirectory: shapeDirectory, cleanHours: cleanHours, cleanSoleOffice: cleanSoleOffice, WEEKDAYS: WEEKDAYS };
