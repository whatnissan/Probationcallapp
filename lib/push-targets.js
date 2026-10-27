// Who gets a morning result push, and what the app's Push choice means.
// Pure; server.js does the I/O and test/push-targets.test.js pins the rules.
// Dave's rulings, 2026-10-28 (option A).
//
// WHICH DEVICES. Every device seen within RECENT_DAYS gets the push, newest
// first, and the text is held behind it (cancelled by an ack from any of
// them). Until this date only the single most recently seen device got it —
// guarding against the 2026-09-05 push that went to a stale token while the
// live phone got nothing. Pushing to every recent device keeps the freshest
// one in the set, so that cannot recur, and an iPad user is no longer left
// out. If NO device is recent, the freshest still gets a courtesy push but
// the text is NOT held: on 2026-10-28, 4 of 8 push accounts had only devices
// unseen for 14+ days, and 161 of October's 167 pushes ended in the text
// anyway — four minutes late. A device's last_seen_at moves at most daily,
// when the app is opened, so "recent" means "opened in the last 14 days".
var RECENT_DAYS = 14;
var DAY_MS = 24 * 60 * 60 * 1000;

function isRecent(lastSeenAt, nowMs) {
  var t = Date.parse(lastSeenAt);
  return Number.isFinite(t) && (nowMs - t) <= RECENT_DAYS * DAY_MS;
}

// devices: live device_tokens rows ({ token, environment, last_seen_at }).
//   → { mode: 'recent' | 'stale' | 'none', targets: [...], holdText }
function choosePushTargets(devices, nowMs) {
  var list = (devices || []).filter(function(d) { return d && d.token; }).slice()
    .sort(function(a, b) { return String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')); });
  var recent = list.filter(function(d) { return isRecent(d.last_seen_at, nowMs); });
  if (recent.length) return { mode: 'recent', targets: recent, holdText: true };
  if (list.length) return { mode: 'stale', targets: [list[0]], holdText: false };
  return { mode: 'none', targets: [], holdText: false };
}

// The §3 notifyMethods a client sees: the stored sms/email part, with 'push'
// in front when the preference is on.
function notifyMethodsFor(storedMethod, notifyPush) {
  var base = storedMethod === 'both' ? ['email', 'sms'] : storedMethod === 'sms' ? ['sms'] : ['email'];
  return notifyPush ? ['push'].concat(base) : base;
}

// THE BUILD GATE. What a PUT /schedule save does to the stored preference:
//   true       'push' is in notifyMethods — any build may turn Push ON
//   false      'push' is absent AND the app is build >= minBuild
//   undefined  leave it as it is: the legacy single-value notifyMethod
//              shape, an absent array, or an OLDER build omitting 'push'.
//
// Why build-sniffing in a save path: until the cut-over build (25, Dave,
// 2026-10-28) the server never returned 'push', so every older build's
// Account sheet reopened with Push unticked — and saving any notification
// change sent notifyMethods without it. Honouring that absence would turn
// push off for everyone who touched their settings. So an older build can
// turn Push on, never off. minBuild comes from PUSH_PREF_MIN_BUILD; unset
// means NO build may turn it off yet (fails safe if the release slips).
function pushPreferenceFromSave(opts) {
  opts = opts || {};
  if (!Array.isArray(opts.notifyMethods)) return undefined;
  var wanted = opts.notifyMethods.map(function(x) { return String(x).trim().toLowerCase(); });
  if (wanted.indexOf('push') >= 0) return true;
  var build = parseInt(opts.build, 10);
  if (opts.minBuild === null || opts.minBuild === undefined || !Number.isFinite(build)) return undefined;
  return build >= opts.minBuild ? false : undefined;
}

// PUSH_PREF_MIN_BUILD → a build number, or null (unset or not a number).
function minBuildFromEnv(value) {
  var n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = {
  RECENT_DAYS: RECENT_DAYS,
  isRecent: isRecent,
  choosePushTargets: choosePushTargets,
  notifyMethodsFor: notifyMethodsFor,
  pushPreferenceFromSave: pushPreferenceFromSave,
  minBuildFromEnv: minBuildFromEnv
};
