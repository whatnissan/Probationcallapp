// A per-key write throttle: "have we already done this for this key
// recently?" Pure and bounded, so it can be tested and cannot grow without
// limit on a busy process.
//
// Built for auth()'s last_login write, which fired on EVERY authenticated
// request. On 2026-09-03 a request loop against a web endpoint turned that
// into hundreds of PATCH /rest/v1/profiles per second on a single row. The
// column is displayed as a date and has never needed per-request precision.
function createThrottle(intervalMs, maxKeys) {
  var seen = new Map();
  var max = maxKeys || 5000;
  return {
    // true = do the write now (and record it); false = skip, too soon.
    take: function(key, nowMs) {
      if (!key) return false;
      var now = nowMs === undefined ? Date.now() : nowMs;
      var prev = seen.get(key);
      if (prev !== undefined && (now - prev) < intervalMs) return false;
      // Re-insert so iteration order is least-recent-first for the trim below.
      seen.delete(key);
      seen.set(key, now);
      if (seen.size > max) seen.delete(seen.keys().next().value);
      return true;
    },
    size: function() { return seen.size; }
  };
}
module.exports = { createThrottle: createThrottle };
