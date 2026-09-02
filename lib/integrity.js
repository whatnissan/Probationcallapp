// Ledger and onboarding integrity helpers, pure so they can be tested.
//
// ledgerMismatches: after migration 044 every profile's balance equals the
// sum of its ledger rows. Anything that breaks that is a silent balance
// write — the class of bug that hid the trigger-granted starter credits for
// nine months. The nightly digest reports these.
function ledgerMismatches(profiles, ledgerRows) {
  var sums = {};
  (ledgerRows || []).forEach(function(r) { sums[r.user_id] = (sums[r.user_id] || 0) + (Number(r.amount) || 0); });
  var out = [];
  (profiles || []).forEach(function(p) {
    var credits = Number(p.credits) || 0, s = sums[p.id] || 0;
    if (credits !== s) out.push({ userId: p.id, credits: credits, ledgerSum: s, gap: credits - s });
  });
  return out;
}

// sharedPhoneFlag: a notify number already on OTHER accounts' schedules.
// Returns the flag row to insert, or null. Never a refusal — the caller only
// records it; the earned extension is what an open flag withholds.
function sharedPhoneFlag(userId, phone, schedulesOnPhone) {
  var others = (schedulesOnPhone || []).map(function(s) { return s.user_id; })
    .filter(function(id, i, a) { return id && id !== userId && a.indexOf(id) === i; });
  if (!phone || !others.length) return null;
  return {
    user_id: userId,
    reason: 'shared_phone',
    details: { phoneLast4: String(phone).slice(-4), otherUserIds: others, otherAccounts: others.length }
  };
}

// app_settings values are JSON scalars ("5", "false", "\"text\"").
function parseSettingValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    var n = Number(value);
    if (value.trim() !== '' && Number.isFinite(n)) return n;
    return value;
  }
  return fallback;
}

module.exports = { ledgerMismatches: ledgerMismatches, sharedPhoneFlag: sharedPhoneFlag, parseSettingValue: parseSettingValue };
