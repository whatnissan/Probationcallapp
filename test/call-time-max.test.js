const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const dash = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
const contract = fs.readFileSync(path.join(__dirname, '..', 'API_CONTRACT.md'), 'utf8');

// 2026-10-02: Montgomery's latest call time is 13:55. The hotline window
// closes at 2 PM and shared slots dial 45 s apart, so 13:55 keeps the last
// subscriber in a slot before close. It was 14:59.

test('every writer refuses a Montgomery time after 13:55', () => {
  assert.match(server, /const LATEST_CALL_MINUTES = 13 \* 60 \+ 55;/);
  const v1 = server.slice(server.indexOf("app.put('/api/v1/schedule'"), server.indexOf("app.put('/api/v1/schedule'") + 5000);
  assert.match(v1, /hour \* 60 \+ minute > LATEST_CALL_MINUTES/);
  assert.match(v1, /between 06:00 and 13:55 for Montgomery County/);
  const web = server.slice(server.indexOf("app.post('/api/schedule'"), server.indexOf("app.post('/api/schedule'") + 5000);
  assert.match(web, /hour \* 60 \+ minute > LATEST_CALL_MINUTES/);
  assert.match(web, /between 6:00 AM and 1:55 PM', field: 'callTime'/);
  assert.ok(!/MAX_HOUR/.test(server), 'the old 14:59 bound is gone');
});

test('the app is told 13:55, and the website offers nothing later', () => {
  assert.match(server, /closesAt: '13:55', retryCutoff: '14:00'/);
  assert.ok(!/value="14">2 PM</.test(dash), 'no 2 PM option in either Montgomery picker');
  assert.match(dash, /hour \* 60 \+ minute > 13 \* 60 \+ 55/);
  assert.ok(!/2:59 PM/.test(dash));
});

test('the contract says 13:55', () => {
  assert.match(contract, /"closesAt": "13:55"/);
  assert.match(contract, /\*\*Montgomery's latest call time is 13:55 \(2026-10-02\)\.\*\*/);
});
