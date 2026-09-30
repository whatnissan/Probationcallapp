const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const dash = fs.readFileSync(path.join(root, 'public', 'dashboard.html'), 'utf8');

// 2026-09-30: the website stored Fort Bend times below §4.7's 05:10 floor
// (its pickers offered 5:00 and 5:05, its writer had no floor), and the
// app's PUT — a full replace that sends the stored time back — then refused
// EVERY save from those subscribers. Separately, the website's Fort Bend
// picker turned every round hour into :10 (`parseInt(...) || 10`).

// Pull a top-level `function name(...) { ... }` out of the page by brace
// matching, so the page's own code is what runs here.
function extract(name) {
  const start = dash.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' should be in dashboard.html');
  let depth = 0;
  for (let i = dash.indexOf('{', start); i < dash.length; i++) {
    if (dash[i] === '{') depth++;
    else if (dash[i] === '}' && --depth === 0) return dash.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

function pageFns() {
  const ctx = { document: { createElement: () => ({ value: '', textContent: '', disabled: false, hidden: false }) } };
  vm.createContext(ctx);
  vm.runInContext(['hourLabel', 'pad2', 'setPickerValue', 'applyFtbendFloor'].map(extract).join('\n'), ctx);
  return ctx;
}

// Enough of HTMLSelectElement for these helpers: options, value, selectedIndex, insertBefore.
function select(values, selected) {
  const s = {
    options: values.map((v) => ({ value: String(v), textContent: String(v), disabled: false, hidden: false })),
    selectedIndex: -1,
    get value() { return this.selectedIndex >= 0 ? this.options[this.selectedIndex].value : ''; },
    set value(v) { this.selectedIndex = this.options.findIndex((o) => o.value === String(v)); },
    insertBefore(opt, ref) { const i = ref ? this.options.indexOf(ref) : this.options.length; this.options.splice(i, 0, opt); }
  };
  s.value = selected;
  return s;
}
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

test('at 5 AM the Fort Bend picker offers nothing before :10, and moves a lower pick up', () => {
  const { applyFtbendFloor } = pageFns();
  const hour = select([5, 6, 7, 8, 9], 5);
  const min = select(MINUTES, 5);
  applyFtbendFloor(hour, min, true);
  assert.deepStrictEqual(min.options.filter((o) => o.disabled).map((o) => o.value), ['0', '5']);
  assert.strictEqual(min.value, '10', '5:05 becomes 5:10, the first time allowed');
  hour.value = 6;
  applyFtbendFloor(hour, min, true);
  assert.strictEqual(min.options.filter((o) => o.disabled).length, 0, 'every minute is fine from 6 AM');
});

test('the floor is Fort Bend only', () => {
  const { applyFtbendFloor } = pageFns();
  const min = select([0, 15, 30, 45], 0);
  applyFtbendFloor(select([5, 6], 5), min, false);
  assert.strictEqual(min.value, '0');
  assert.strictEqual(min.options.filter((o) => o.disabled).length, 0);
});

test('a stored time the picker does not list is added, not replaced by a default', () => {
  const { setPickerValue, hourLabel, pad2 } = pageFns();
  const hour = select([5, 6, 7, 8, 9], 5);
  setPickerValue(hour, 10, hourLabel(10));
  assert.strictEqual(hour.value, '10', 'an app-set 10 AM survives a web save');
  assert.deepStrictEqual(hour.options.map((o) => o.value), ['5', '6', '7', '8', '9', '10'], 'in order');
  assert.strictEqual(hour.options[5].textContent, '10 AM');
  const min = select(MINUTES, 10);
  setPickerValue(min, 7, pad2(7));
  assert.strictEqual(min.value, '7');
  assert.strictEqual(min.options[2].value, '7', 'slotted between 05 and 10');
  setPickerValue(min, 0, pad2(0));
  assert.strictEqual(min.value, '0', 'a stored :00 is shown as :00');
});

test('the website no longer turns a round hour into :10', () => {
  assert.ok(!/ftbendNotifyMin'\)\.value\) \|\| 10/.test(dash), 'save: no `|| 10` on the parsed minute');
  assert.ok(!/ftbendNotifyMin'\)\.value = d\.schedule\.minute \|\| 10/.test(dash), 'load: no `|| 10` on the stored minute');
  assert.match(dash, /if \(isNaN\(minute\)\) minute = 10;/, 'only a missing value takes the default');
  assert.match(dash, /hour \* 60 \+ minute < 5 \* 60 \+ 10/, 'the form refuses below the floor before sending');
});

test('both hour pickers and the onboarding county switch apply the floor', () => {
  assert.match(dash, /id="ftbendNotifyHour"[^>]*onchange="applyFtbendFloor\(this, document\.getElementById\('ftbendNotifyMin'\), true\)"/);
  assert.match(dash, /id="onboardHour"[^>]*onchange="applyFtbendFloor\(this, document\.getElementById\('onboardMinute'\), document\.getElementById\('onboardCounty'\)\.value === 'ftbend'\)"/);
  assert.match(dash, /applyFtbendFloor\(document\.getElementById\('onboardHour'\), document\.getElementById\('onboardMinute'\), ftbend\);/);
});

test('the website writer refuses a Fort Bend time below 5:10 before it writes anything', () => {
  const start = server.indexOf("app.post('/api/schedule'");
  const body = server.slice(start, start + 6000);
  const floor = body.indexOf('ftFloorHour < 5 || (ftFloorHour === 5 && ftFloorMin < 10)');
  const firstWrite = body.search(/\.update\(|\.insert\(|\.upsert\(/);
  assert.ok(floor > 0, 'the website writer has the Fort Bend floor');
  assert.ok(firstWrite > floor, 'and checks it before the colour is saved');
  assert.match(body, /field: 'callTime'/);
  // It must judge the same numbers it stores.
  assert.match(body, /var ftFloorHour = parseInt\(req\.body\.hour\) \|\| 6;/);
  assert.match(body, /var hour = parseInt\(req\.body\.hour\) \|\| 6;/);
  // And the v1 floor it mirrors is still there.
  assert.match(server, /county === 'ftbend' && \(hour < 5 \|\| \(hour === 5 && minute < 10\)\)/);
});

test('migration 064 backs up before it moves, moves only below-floor Fort Bend rows, and records itself', () => {
  const sql = fs.readFileSync(path.join(root, 'migrations', '064_ftbend_time_floor.sql'), 'utf8')
    .replace(/--.*$/gm, '');
  const where = "county = 'ftbend'";
  const backup = sql.indexOf('INSERT INTO ftbend_time_floor_064');
  const update = sql.indexOf('UPDATE user_schedules');
  assert.ok(backup > 0 && update > backup, 'originals are saved before any row changes');
  assert.match(sql.slice(update), /SET hour = 5, minute = 10\s+WHERE county = 'ftbend'\s+AND \(hour < 5 OR \(hour = 5 AND minute < 10\)\);/);
  assert.ok(sql.slice(backup, update).includes(where), 'the backup selects the same rows');
  assert.match(sql, /REVOKE ALL ON ftbend_time_floor_064 FROM anon, authenticated;/);
  assert.match(sql, /ALTER TABLE ftbend_time_floor_064 ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /INSERT INTO schema_migrations \(filename, note\)\s+VALUES \('064_ftbend_time_floor\.sql'/);
});
