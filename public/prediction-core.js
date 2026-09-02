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
  // Window classification (2026-08-25 backtest, 17 walk-forward forecasts):
  // the old min-max envelope missed 35% prospectively — most misses are new
  // record extremes, which an envelope cannot contain by definition — and
  // every tighter percentile band traded width for MORE misses (P20-P80:
  // 41% coverage). Below MIN_PRIORS completed intervals, each observation
  // carries 20%+ of the distribution's mass, so a "percentile" is one data
  // point in costume. A user earns the two-number presentation only when
  // their own walk-forward self-test clears STABILITY_* — otherwise the
  // honest output is "too irregular to narrow", which the backtest showed
  // is the correct answer for most users.
  var MIN_PRIORS = 5;
  var STABILITY_MIN_ORIGINS = 3;
  var STABILITY_MIN_COVERAGE = 0.7;
  // County range for the `insufficient` state (2026-09-02 backtest, second
  // set: users with 2-4 intervals). Their own envelope covered 41% of a
  // separate 17-origin set; a county-POOLED-ONLY 80% band covered 88% with a
  // 10-day worst miss — and pooled-only beat a hierarchical blend (82%,
  // wider) while being literally what the copy claims: the county's range,
  // not the user's. The gate is on the POOL, not the person: below this the
  // county fact isn't measurable either, and the honest output is nothing.
  var COUNTY_RANGE_MASS = 0.8;
  var COUNTY_POOL_MIN_INTERVALS = 20;
  var COUNTY_POOL_MIN_USERS = 3;
  var COUNTY_RANGE_MAX_DAYS = 240;

  // Weighted quantile: value-sorted pairs, c_j = (S_j - w_j/2)/W, linear
  // interpolation between the c's.
  function wquantile(vals, weights, p) {
    var pairs = vals.map(function(v, i) { return [v, weights[i]]; }).sort(function(a, b) { return a[0] - b[0]; });
    var W = pairs.reduce(function(s, x) { return s + x[1]; }, 0);
    var S = 0;
    var c = pairs.map(function(x) { S += x[1]; return (S - x[1] / 2) / W; });
    if (p <= c[0]) return pairs[0][0];
    if (p >= c[c.length - 1]) return pairs[pairs.length - 1][0];
    for (var j = 0; j + 1 < c.length; j++) {
      if (p >= c[j] && p <= c[j + 1]) {
        return pairs[j][0] + ((p - c[j]) / (c[j + 1] - c[j])) * (pairs[j + 1][0] - pairs[j][0]);
      }
    }
    return pairs[pairs.length - 1][0];
  }

  // Recency-weighted P10-P90 (half-life 4 intervals), rounded OUTWARD.
  function innerBandOf(priors) {
    var w = priors.map(function(_, i) { return Math.pow(0.5, (priors.length - 1 - i) / HALF_LIFE_INTERVALS); });
    return [Math.floor(wquantile(priors, w, 0.10)), Math.ceil(wquantile(priors, w, 0.90))];
  }

  // Classify what window, if any, the user's history can honestly support.
  // 'two_number': inner recent-historical-range + outer has-ranged bound.
  // 'irregular': the user's own walk-forward self-test failed — no narrow
  //              window is defensible; show the outer bound as history-fact.
  // 'insufficient': fewer than MIN_PRIORS completed intervals.
  function classifyWindow(used) {
    if (used.length < MIN_PRIORS) {
      return { state: 'insufficient', intervalsUsed: used.length, needed: MIN_PRIORS, innerDays: null, outerDays: null, scoredOrigins: 0, innerCoverage: null };
    }
    var outer = [Math.min.apply(null, used), Math.max.apply(null, used)];
    var scored = 0, hits = 0;
    for (var t = MIN_PRIORS; t < used.length; t++) {
      var b = innerBandOf(used.slice(0, t));
      scored++;
      if (used[t] >= b[0] && used[t] <= b[1]) hits++;
    }
    var stable = scored >= STABILITY_MIN_ORIGINS && (hits / scored) >= STABILITY_MIN_COVERAGE;
    // `needed` is the MIN_PRIORS gate and it is meaningful in EVERY state —
    // "9 intervals against a gate of 5" is as useful as "2 of 5". It used to
    // appear only on `insufficient`, which left clients decoding undefined on
    // the other two and unable to tell "gate not applicable" from "gate
    // unknown". Always present now.
    var base = { intervalsUsed: used.length, needed: MIN_PRIORS, outerDays: outer, scoredOrigins: scored, innerCoverage: scored ? Math.round((hits / scored) * 100) / 100 : null };
    if (!stable) return Object.assign({ state: 'irregular', innerDays: null }, base);
    return Object.assign({ state: 'two_number', innerDays: innerBandOf(used) }, base);
  }

  // Completed intervals from one user's call_history rows, under the rules
  // in the header. ONE implementation: the personal model and the county
  // pool must count intervals identically, or the county range would be
  // built from a different definition of "interval" than the one it is
  // shown beside.
  function intervalsOf(history) {
    var rows = (history || []).slice().sort(function(a, b) {
      return new Date(a.created_at) - new Date(b.created_at);
    });
    var tests = rows.filter(function(h) { return h.result === 'MUST_TEST'; });

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
    return { tests: tests, used: used, sub7Count: sub7Count, longIncluded: longIncluded, longDropped: longDropped };
  }

  // The county range: central COUNTY_RANGE_MASS of a Gaussian kernel density
  // over the LOG of every completed interval in the pool, evaluated on whole
  // days. Log space because intervals are right-skewed (a 63-day gap and a
  // 4-day gap are both real); Scott's bandwidth (sd · n^(-1/5)), which is
  // what the backtest scored. Quantiles are the first whole day at which
  // the cumulative mass reaches 10% / 90%, exactly as scored — do not
  // "improve" the rounding without re-running the backtest.
  //
  // `intervalsByUser` is an array of arrays: one entry per pooled user,
  // holding that user's completed intervals. The CALLER decides who is in
  // the pool (same county, not the user themself, not internal accounts).
  // Returns null when the pool is below the gate.
  function countyRangeOf(intervalsByUser) {
    var users = (intervalsByUser || []).filter(function(iv) { return iv && iv.length; });
    var pool = [];
    users.forEach(function(iv) { iv.forEach(function(d) { if (d > 0) pool.push(d); }); });
    if (pool.length < COUNTY_POOL_MIN_INTERVALS || users.length < COUNTY_POOL_MIN_USERS) return null;
    var logs = pool.map(function(d) { return Math.log(d); });
    var n = logs.length;
    var mean = logs.reduce(function(a, b) { return a + b; }, 0) / n;
    var sd = Math.sqrt(logs.reduce(function(a, b) { return a + (b - mean) * (b - mean); }, 0) / (n - 1));
    var h = Math.max(1e-6, sd * Math.pow(n, -0.2));
    var pdf = [], total = 0;
    for (var d = 1; d <= COUNTY_RANGE_MAX_DAYS; d++) {
      var ld = Math.log(d), f = 0;
      for (var i = 0; i < n; i++) {
        var z = (ld - logs[i]) / h;
        f += Math.exp(-0.5 * z * z);
      }
      f = f / d; // Jacobian: density in day units, not log-day units
      pdf.push(f); total += f;
    }
    var lo = (1 - COUNTY_RANGE_MASS) / 2, hi = 1 - lo;
    var cum = 0, lowDays = null, highDays = null;
    for (var k = 0; k < pdf.length; k++) {
      cum += pdf[k] / total;
      if (lowDays === null && cum >= lo) lowDays = k + 1;
      if (highDays === null && cum >= hi) { highDays = k + 1; break; }
    }
    if (lowDays === null || highDays === null) return null;
    return {
      lowDays: lowDays,
      highDays: highDays,
      mass: COUNTY_RANGE_MASS,
      basedOnIntervals: pool.length,
      basedOnUsers: users.length
    };
  }

  function computePrediction(history, sysStats, nowMs) {
    var now = nowMs || Date.now();
    var iv = intervalsOf(history);
    var tests = iv.tests;
    if (!tests.length) return null;
    var used = iv.used, sub7Count = iv.sub7Count, longIncluded = iv.longIncluded, longDropped = iv.longDropped;

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
      weekOfMonthCounts: weekCounts,
      window: classifyWindow(used)
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
    intervalsOf: intervalsOf,
    countyRangeOf: countyRangeOf,
    DAY_GRID_MIN_TESTS: DAY_GRID_MIN_TESTS,
    COUNTY_POOL_MIN_INTERVALS: COUNTY_POOL_MIN_INTERVALS,
    COUNTY_POOL_MIN_USERS: COUNTY_POOL_MIN_USERS
  };
})(typeof window !== 'undefined' ? window : this);
