// Shared test-frequency prediction math. Loaded by BOTH dashboard.html
// (user-facing card) and admin.html (user modal) so the two copies of this
// logic can never drift apart again. Pure computation — no DOM.
//
// Model decisions (2026-08-21, after the escalation analysis):
//  - ALL positive gaps count, including sub-7-day ones. The old model
//    excluded <7d gaps as "retests" — but a rapid re-call is the county's
//    escalation response to a missed test, i.e. exactly the signal this
//    model exists to catch. They are still counted separately so the UI can
//    say how many occurred.
//  - Gaps >= 60 days are included only when call coverage across the gap is
//    >= 60% (we were watching and the county genuinely didn't call — e.g.
//    ewing's real 63-day gap had 91% coverage). Low coverage means the gap
//    is an observation hole (schedule off / no credits), not a cadence fact.
//  - Recency weighting: exponential decay, half-life 4 intervals. A cadence
//    change (post-miss escalation) moves the estimate within 2-3 tests,
//    without a hard regime split on 3-point samples.
//  - Escalation flag: informational only — the latest interval landing at or
//    under half the running median of the prior intervals.
//  - NO "confidence %". The old score was min(88, max(40, ...)) — a
//    hand-tuned number with no probabilistic meaning whose 40% floor made
//    thin data look moderately certain. Sample size is the honest signal.
//  - Day-of-week coloring must EARN display: >= DAY_GRID_MIN_TESTS tests
//    AND a chi-square test against uniform (df=6, p<0.05). Below that the
//    grid renders as a uniform neutral strip — a green cell on 0-2
//    observations reads as "safe day", and a user who plans around it and
//    gets called was failed by us.

(function(global) {
  var HALF_LIFE_INTERVALS = 4;
  var LONG_GAP_DAYS = 60;
  var LONG_GAP_MIN_COVERAGE = 0.6;
  var DAY_GRID_MIN_TESTS = 35;
  var CHI2_CRIT_DF6_P05 = 12.592;
  var ESCALATION_MIN_INTERVALS = 4;

  function computePrediction(history, sysStats, nowMs) {
    var now = nowMs || Date.now();
    var rows = (history || []).slice().sort(function(a, b) {
      return new Date(a.created_at) - new Date(b.created_at);
    });
    var tests = rows.filter(function(h) { return h.result === 'MUST_TEST'; });
    if (!tests.length) return null;

    // Days on which ANY call ran — coverage evidence for long gaps.
    var observedDays = {};
    rows.forEach(function(r) { observedDays[String(r.created_at).slice(0, 10)] = true; });

    var used = [], sub7Count = 0, longIncluded = 0, longDropped = 0;
    for (var i = 1; i < tests.length; i++) {
      var a = new Date(tests[i - 1].created_at), b = new Date(tests[i].created_at);
      var days = Math.round((b - a) / 86400000);
      if (days <= 0) continue;
      if (days < 7) sub7Count++;
      if (days >= LONG_GAP_DAYS) {
        var obs = 0;
        for (var t = a.getTime() + 86400000; t < b.getTime(); t += 86400000) {
          if (observedDays[new Date(t).toISOString().slice(0, 10)]) obs++;
        }
        if (obs / Math.max(1, days - 1) < LONG_GAP_MIN_COVERAGE) { longDropped++; continue; }
        longIncluded++;
      }
      used.push(days);
    }

    // Recency-weighted mean and standard deviation (newest interval last).
    var avgDays = null, stdDays = null;
    if (used.length) {
      var num = 0, den = 0;
      used.forEach(function(v, idx) {
        var w = Math.pow(0.5, (used.length - 1 - idx) / HALF_LIFE_INTERVALS);
        num += v * w; den += w;
      });
      avgDays = num / den;
      if (used.length >= 2) {
        var vnum = 0;
        used.forEach(function(v, idx) {
          var w = Math.pow(0.5, (used.length - 1 - idx) / HALF_LIFE_INTERVALS);
          vnum += w * Math.pow(v - avgDays, 2);
        });
        stdDays = Math.sqrt(vnum / den);
      }
    }

    // Escalation flag: latest interval <= half the running median of the rest.
    var escalation = null;
    if (used.length >= ESCALATION_MIN_INTERVALS) {
      var prior = used.slice(0, -1).slice().sort(function(x, y) { return x - y; });
      var med = prior.length % 2 ? prior[(prior.length - 1) / 2]
        : (prior[prior.length / 2 - 1] + prior[prior.length / 2]) / 2;
      var lastGap = used[used.length - 1];
      if (med > 0 && lastGap <= med / 2) {
        escalation = { lastGapDays: lastGap, medianDays: med };
      }
    }

    // Blend with system-wide stats when personal data is thin (unchanged
    // policy: full personal weight at 8+ intervals).
    var sysAvg = sysStats ? sysStats.scheduledAvg : null;
    var sysStd = sysStats ? sysStats.scheduledStdDev : null;
    var blendedAvg = null, blendedStd = null, sourceLabel = 'not enough data';
    if (avgDays !== null && sysAvg) {
      var pw = Math.min(1, used.length / 8), sw = 1 - pw;
      blendedAvg = sysAvg * sw + avgDays * pw;
      blendedStd = (sysStd || 3) * sw + (stdDays || sysStd || 3) * pw;
      sourceLabel = pw < 0.5 ? 'county + your history' : 'your history + county';
    } else if (avgDays !== null) {
      blendedAvg = avgDays; blendedStd = stdDays || 3; sourceLabel = 'your history';
    } else if (sysAvg) {
      blendedAvg = sysAvg; blendedStd = sysStd || 3; sourceLabel = 'county average';
    }

    var last = tests[tests.length - 1];
    var daysSince = Math.round((now - new Date(last.created_at)) / 86400000);
    var totalDays = Math.max(1, Math.round((now - new Date(tests[0].created_at)) / 86400000));

    var predict = null;
    if (blendedAvg !== null) {
      var spread = blendedStd || 3;
      predict = {
        daysUntil: Math.round(blendedAvg - daysSince),
        lo: Math.max(0, Math.round(blendedAvg - spread - daysSince)),
        hi: Math.max(0, Math.round(blendedAvg + spread - daysSince))
      };
    }

    // Day-of-week grid: earn coloring or stay uniform.
    var dayCounts = [0, 0, 0, 0, 0, 0, 0];
    tests.forEach(function(t) { dayCounts[new Date(t.created_at).getDay()]++; });
    var show = false, reason = '';
    if (tests.length < DAY_GRID_MIN_TESTS) {
      reason = 'needs ' + DAY_GRID_MIN_TESTS + '+ tests (' + tests.length + ' so far)';
    } else {
      var exp = tests.length / 7, chi2 = 0;
      dayCounts.forEach(function(c) { chi2 += Math.pow(c - exp, 2) / exp; });
      if (chi2 > CHI2_CRIT_DF6_P05) show = true;
      else reason = 'no significant day pattern in ' + tests.length + ' tests';
    }
    var maxDay = Math.max.apply(null, dayCounts);
    var pct = dayCounts.map(function(c) { return maxDay > 0 ? c / maxDay : 0; });

    // Week-of-month (1..5), same statistical gate as the day grid — five
    // sparse bins lie just as fluently as seven.
    var weekCounts = [0, 0, 0, 0, 0];
    tests.forEach(function(t) {
      var w = Math.min(5, Math.ceil(new Date(t.created_at).getDate() / 7));
      weekCounts[w - 1]++;
    });

    // Real recent history for display — actual dates, no inference.
    var recent = tests.slice(-6).map(function(t) { return String(t.created_at).slice(0, 10); });

    return {
      tests: tests.length,
      recentTests: recent,
      daysSince: daysSince,
      totalDays: totalDays,
      perMonth: ((tests.length / totalDays) * 30).toFixed(1),
      usedIntervals: used.length,
      sub7Count: sub7Count,
      longIncluded: longIncluded,
      longDropped: longDropped,
      avgDays: blendedAvg,
      stdDays: blendedStd,
      sourceLabel: sourceLabel,
      escalation: escalation,
      predict: predict,
      dayGrid: { show: show, reason: reason, counts: dayCounts, pct: pct },
      weekOfMonthCounts: weekCounts
    };
  }

  // County-level weekday pattern from pooled MUST_TEST day counts (served in
  // systemStats.dayOfWeekCounts). Two-stage test, because the pooled 2026-08
  // data clears the full-week chi-square (30.5, p<0.01) ENTIRELY on weekends
  // (2 of 72 tests ever) while the weekday-only test (df=4) does not clear —
  // i.e. the county is a weekday service with random weekday choice. Display
  // must label this county-wide, never as the user's own pattern, and never
  // as safe days.
  function countyDayPattern(sysStats) {
    var c = sysStats && sysStats.dayOfWeekCounts;
    if (!c || c.length !== 7) return null;
    var n = c.reduce(function(a, b) { return a + b; }, 0);
    if (n < 30) return null;
    var exp = n / 7, chi2 = 0;
    c.forEach(function(v) { chi2 += Math.pow(v - exp, 2) / exp; });
    var wk = c.slice(1, 6), wn = wk.reduce(function(a, b) { return a + b; }, 0);
    var wexp = wn / 5, wchi = 0;
    wk.forEach(function(v) { wchi += Math.pow(v - wexp, 2) / wexp; });
    return {
      total: n,
      weekendCount: c[0] + c[6],
      fullWeekSignificant: chi2 > 12.592, // df=6 @ 0.05
      weekdaySignificant: wchi > 9.488    // df=4 @ 0.05
    };
  }

  global.PredictionCore = {
    computePrediction: computePrediction,
    countyDayPattern: countyDayPattern,
    DAY_GRID_MIN_TESTS: DAY_GRID_MIN_TESTS
  };
})(typeof window !== 'undefined' ? window : this);
