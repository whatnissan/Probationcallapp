const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const contract = fs.readFileSync(path.join(__dirname, '..', 'API_CONTRACT.md'), 'utf8');

// 2026-10-01: the app may say "expired" only when a recording existed and the
// 30-day deletion removed it. A row that never had audio is "none".

function extract(name) {
  const start = server.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' should be in server.js');
  let depth = 0;
  for (let i = server.indexOf('{', start); i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}' && --depth === 0) return server.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
const ctx = vm.createContext({});
vm.runInContext(extract('v1RecordingStatus'), ctx);
const status = ctx.v1RecordingStatus;

test('available, expired and none mean exactly what they say', () => {
  assert.strictEqual(status({ recording_url: 'https://api.twilio.com/x/RE1.mp3' }), 'available');
  assert.strictEqual(status({ recording_url: 'demo:sample' }), 'available', 'the demo recording plays');
  assert.strictEqual(status({ recording_url: null, recording_deleted_at: '2026-10-01T08:00:00Z' }), 'expired');
  assert.strictEqual(status({ recording_url: null, recording_deleted_at: null }), 'none', 'never had one: not "expired"');
  assert.strictEqual(status({ recording_url: null, recording_duration_seconds: 14 }), 'none',
    'a duration alone is not a deletion — the migration turns that into a marker, the server does not guess');
  assert.strictEqual(status(null), 'none');
});

test('every v1 surface that carries a recording carries the status', () => {
  const today = server.slice(server.indexOf("app.get('/api/v1/today'"), server.indexOf("app.get('/api/v1/today'") + 9000);
  assert.match(today, /recordingStatus: 'none',/, '/today defaults to none (nothing resolved yet)');
  assert.match(today, /payload\.recordingStatus = v1RecordingStatus\(resultRow\);/, 'and takes the resolved row\'s');
  const hist = server.slice(server.indexOf("app.get('/api/v1/history'"), server.indexOf("app.get('/api/v1/history'") + 9000);
  assert.match(hist, /recordingStatus: v1RecordingStatus\(r\),/);
  const call = server.slice(server.indexOf("app.get('/api/v1/calls/:callId'"), server.indexOf("app.get('/api/v1/calls/:callId'") + 3000);
  assert.match(call, /recordingStatus: v1RecordingStatus\(row\.data\)/);
});

test('the contract defines the status and the Fort Bend office rule', () => {
  assert.match(contract, /\*\*`recordingStatus` \(2026-10-01\)\*\*/);
  assert.match(contract, /This\s+is the ONLY value a client may render as "expired"\./);
  assert.match(contract, /\*\*Never another office's audio\.\*\*/);
  assert.match(contract, /\*\*No call of our own, no recording\.\*\*/);
});
