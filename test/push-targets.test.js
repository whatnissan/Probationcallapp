const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const t = require('../lib/push-targets');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// The Push choice and which devices get a result push (Dave, 2026-10-28,
// option A). Rules here; the behaviour through the real server is in
// test/push-preference.test.js.

const NOW = Date.parse('2026-10-28T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

// ---------------------------------------------------------------------------
// THE BUILD GATE — why there is User-Agent build-sniffing in PUT /schedule.
//
// Until build 25 the server never returned 'push' in notifyMethods, so every
// older build's Account sheet reopened with Push UNTICKED, whatever the person
// had chosen. Saving any notification change from those builds therefore sends
// notifyMethods WITHOUT 'push' — by accident. If the server honoured that
// absence, it would silently switch push off for anyone on an older build who
// touched their notification settings. So: 'push' present turns Push on from
// any build; 'push' ABSENT turns it off only from the cut-over build
// (PUSH_PREF_MIN_BUILD, 25) onward. Do not remove this gate while builds below
// 25 can still reach the server (profiles.last_app_build says who is left).
// ---------------------------------------------------------------------------
test('build gate: build 24 omitting push NEVER turns Push off; build 25 does', () => {
  const save = (methods, build, minBuild) => t.pushPreferenceFromSave({ notifyMethods: methods, build: build, minBuild: minBuild });
  assert.strictEqual(save(['sms'], '24', 25), undefined, 'build 24: its sheet always showed Push unticked — the absence is an accident, the stored value stands');
  assert.strictEqual(save(['email', 'sms'], '1', 25), undefined);
  assert.strictEqual(save(['sms'], '25', 25), false, 'build 25 loads and shows the stored value: unticked means off');
  assert.strictEqual(save(['sms'], '31', 25), false);
  assert.strictEqual(save(['push', 'sms'], '24', 25), true, 'any build may turn Push ON');
  assert.strictEqual(save(['push', 'email'], '25', 25), true);
  assert.strictEqual(save(['sms'], null, 25), undefined, 'no build in the User-Agent (the website, curl): never off');
  assert.strictEqual(save(['sms'], '99', null), undefined, 'PUSH_PREF_MIN_BUILD unset: nobody can turn it off yet — fails safe if the release slips');
  assert.strictEqual(t.pushPreferenceFromSave({ notifyMethods: undefined, build: '30', minBuild: 25 }), undefined, 'the legacy notifyMethod shape leaves it alone');
  assert.strictEqual(t.minBuildFromEnv('25'), 25);
  assert.strictEqual(t.minBuildFromEnv(undefined), null);
  assert.strictEqual(t.minBuildFromEnv('twenty-five'), null);
});

test('the gate is wired into PUT /schedule, on this request\'s build, from the environment', () => {
  const put = server.slice(server.indexOf("app.put('/api/v1/schedule'"), server.indexOf("app.put('/api/v1/schedule'") + 20000);
  assert.match(put, /var reqBuild = appBuildFromUA\(req\.headers\['user-agent'\]\);/);
  assert.match(put, /var pushMinBuild = pushTargets\.minBuildFromEnv\(process\.env\.PUSH_PREF_MIN_BUILD\);/, 'the cut-over build is a Railway variable, not a constant');
  assert.match(put, /if \(pushPref !== undefined\) data\.notify_push = pushPref;/, 'written only when the save decides it');
  assert.ok(!/notify_push:\s*(true|false)/.test(put), 'never written unconditionally');
});

test('which devices: every one seen within 14 days, newest first', () => {
  const d = (tok, n) => ({ token: tok, environment: 'production', last_seen_at: daysAgo(n) });
  const both = t.choosePushTargets([d('ipad', 9), d('iphone', 1)], NOW);
  assert.strictEqual(both.mode, 'recent');
  assert.deepStrictEqual(both.targets.map((x) => x.token), ['iphone', 'ipad'], 'the iPad is no longer left out; the freshest is first and always included');
  assert.strictEqual(both.holdText, true);
  const mixed = t.choosePushTargets([d('old', 40), d('new', 2)], NOW);
  assert.deepStrictEqual(mixed.targets.map((x) => x.token), ['new'], 'a device unseen for 14+ days is dropped when a recent one exists');
  assert.strictEqual(t.choosePushTargets([d('edge', 14)], NOW).mode, 'recent', '14 days exactly still counts');
});

test('only stale devices: a courtesy push to the freshest, and the text is NOT held', () => {
  const d = (tok, n) => ({ token: tok, environment: 'production', last_seen_at: daysAgo(n) });
  const stale = t.choosePushTargets([d('a', 40), d('b', 20)], NOW);
  assert.strictEqual(stale.mode, 'stale');
  assert.deepStrictEqual(stale.targets.map((x) => x.token), ['b']);
  assert.strictEqual(stale.holdText, false, 'four accounts had only these on 2026-10-28; their text arrived four minutes late every morning');
  assert.deepStrictEqual(t.choosePushTargets([], NOW), { mode: 'none', targets: [], holdText: false });
});

test('notifyMethods out: push first when the preference is on', () => {
  assert.deepStrictEqual(t.notifyMethodsFor('sms', true), ['push', 'sms']);
  assert.deepStrictEqual(t.notifyMethodsFor('both', true), ['push', 'email', 'sms']);
  assert.deepStrictEqual(t.notifyMethodsFor('email', false), ['email']);
  assert.match(server, /notifyMethods: v1NotifyMethods\(row\.notify_method \|\| 'email', row\.notify_push !== false\),/, 'a row without the column reads as on');
  assert.match(server, /select\('quiet_mode, notify_push'\)/, 'the Montgomery push path reads the preference');
});
