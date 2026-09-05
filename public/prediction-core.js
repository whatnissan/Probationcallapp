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

// ---- WHAT THE DATA ACTUALLY SUPPORTS (measured 2026-09-04) ----
// Read this before proposing a model. These are counts, not opinions, and
// they are recorded so the next person re-asks the question against data
// rather than intuition. Re-run the numbers before overriding any of it.
//
// THE POOL, ONCE, FOR EVERY NUMBER BELOW. Montgomery only. Excluded: demo
// accounts, dmlafortune, cajuncowboy, and the whatnissan+ ALIAS accounts
// (onboarding-test signups). The PRIMARY whatnissan account is IN — it dials
// a real PIN for a real person and is genuine county data. Every figure in
// this header is drawn from that one set; do not mix in a differently
// filtered count without saying so, because the totals differ enough to look
// like a contradiction (the demo-only filter gives 83 MUST_TESTs too, but a
// stricter admin-excluding filter gives 72, and both have been in circulation).
//
// SAMPLE SIZE:
//     users with any history        23
//     users with >= 1 MUST_TEST     18
//     MUST_TEST events              83
//     COMPLETED INTERVALS           65        <- the real sample
//     users with >= 3 intervals      8
//     largest single user           14 intervals
//     subscriber-days observed    1759
//
// So: NO MACHINE LEARNING. 65 intervals across 23 users, most contributing
// one or two, is not a training set. A per-user model at n=8 memorises noise;
// a cross-user model has 23 groups with almost nothing in each. The pooled
// county distribution plus per-user quantiles under a walk-forward stability
// gate is the right shape for this n. Revisit when completed intervals are in
// the several hundreds, not before.
//
// THE ELAPSED-TIME HAZARD SHAPE, AND WHY IT CAN NEVER BE SURFACED.
// The daily chance of a MUST_TEST does vary with days-since-last-test:
//     0-7    n= 495  musts=11   2.22%   CI 1.2- 3.9%
//     8-14   n= 378  musts=17   4.50%   CI 2.8- 7.1%
//     15-21  n= 250  musts=11   4.40%   CI 2.5- 7.7%
//     22-30  n= 193  musts=13   6.74%   CI 4.0-11.2%
//     31-45  n= 147  musts= 6   4.08%   CI 1.9- 8.6%
//     46+    n=  54  musts= 7  12.96%   CI 6.4-24.4%
// One contrast is suggestive and no more: the first week after a test (2.22%)
// against the 22-30 day window (6.74%). Their intervals clear each other by
// a tenth of a point (3.9 vs 4.0) — that is not a margin to build on. It is
// not monotonic, 31-45 sits below 22-30, and the 46+ cell rests on 7 events.
//
// IT MUST NOT REACH A USER, and the reason is the rule, not the noise.
// "Your odds are lowest in the first week after a test" is a BELOW-AVERAGE
// claim. Below-average claims are never surfaced, whatever their sample
// size: a person who reads that, relaxes in the week after testing, and is
// called on day 3 was failed by this app. It is the same rule that keeps
// Sunday's 0-of-247 off the screen — see countyElevatedDays() — and it binds
// here even though this effect is better evidenced than most, because the
// direction of the claim is what disqualifies it, not its strength.
//
// The upward half is not usable either: the 22-30 elevation is a fact about
// a window a user is inside for nine days, and saying "days 22-30 run hot"
// invites reading days 1-21 as cool. There is no upward-only framing of a
// hazard CURVE, which is why the weekday signal could ship and this cannot.
//
// TESTED AND REJECTED:
//   BACK-TO-BACK CLUSTERING — the idea that a recent test makes another one
//   MORE likely, inverting the interval assumption. It does not.
//       intervals <= 2 days              2 of 65  = 3.1%
//       P(MUST_TEST | MUST_TEST yday)    1 of 79  = 1.3%
//       base rate P(MUST_TEST | day)     83 of 1744 = 4.8%
//   A test yesterday makes another today roughly a THIRD as likely as
//   baseline. Do not re-propose this without new data that overturns it.
//
//   CADENCE CHANGE AS AN ESTIMATE INPUT — the "tightening" banner is real but
//   far too weak to move a number: lag-1 correlation r = +0.063 across 49
//   consecutive gap pairs, r^2 = 0.004, i.e. 0.4% of variance. (An earlier
//   read on a smaller filtered set gave r = +0.198 / 3.9%; adding the primary
//   whatnissan account's 10 intervals all but erased it, which is itself a
//   lesson about effect sizes at this n.) It stays a warning. Folding it in
//   would move the estimate while adding nothing, which is the worst
//   combination — it looks like precision.
//
//   COUNTY-WIDE DAILY VOLUME — not observable for Montgomery, which is
//   PIN-based: the hotline answers about YOUR pin and never announces how
//   many were called. Fort Bend IS colour-based and does cluster —
//   daily_county_status has held all three offices unconditionally since
//   2025-12-17 — but there is 1 active Fort Bend user, so there is nothing
//   to correlate yet.
//
//   SAME-DAY BATCHING — NOT DETECTABLE AT CURRENT SUBSCRIBER DENSITY
//   (2026-09-04). The question: does the county pull GROUPS, so that one
//   subscriber's MUST_TEST is evidence about every other subscriber's odds
//   that same morning? If it did, that is a same-day signal worth having.
//
//   Measured over 281 dates, 1,759 subscriber-days, 83 MUST_TESTs. Daily
//   distinct-user counts: 214 dates with 0, 54 with 1, 10 with 2, 3 with 3.
//   Raw variance/mean = 1.162.
//
//   Dispersion test against independent per-user selection:
//       pooled rate (weekday NOT controlled)   ratio 1.124   p = 0.076
//       weekday-specific rate (controlled)     ratio 0.970   p = 0.616
//   Controlling for the Thursday effect removes the dispersion entirely —
//   0.970 is very slightly UNDER-dispersed, which is what independence looks
//   like with sampling noise. 20,000 Monte Carlo histories under independent
//   selection, with weekday rates and the real users-observed-per-day:
//       dates with 2+ called      observed 13     simulated mean 13.0   p = 0.548
//       share of musts on those   observed 34.9%  simulated mean 33.8%  p = 0.442
//       busiest single day        observed 3      simulated mean max 3.1
//   Observed sits on the simulated mean on every measure. The 13 multi-user
//   dates are 46% Thursdays against 20% of weekdays, which is the mechanism:
//   people coincide because it is a Thursday, not because they were pulled
//   together.
//
//   WHY THIS IS "NOT DETECTABLE" AND NOT "THE COUNTY DOES NOT BATCH". The
//   test only sees OUR subscribers — 5 to 12 observed on a given day against
//   a county caseload of unknown size. A county calling in batches of ~40
//   PINs would look identical to independence at this density, because two
//   of our handful would rarely land in the same batch. What is established
//   is that at the granularity we can act on, independence is not rejected;
//   the underlying selection mechanism is NOT established.
//
//   RETEST CONDITION: if the Montgomery subscriber pool grows several-fold —
//   enough that a typical day observes tens of users rather than 5-12 — run
//   this again. The same dispersion test and Monte Carlo, weekday-controlled.
//   Until then, do not build a same-day cross-subscriber signal, and do not
//   record this as a settled negative.
//
//   THURSDAY x ELAPSED-TIME INTERACTION — UNMEASURABLE AT n=22 (2026-09-04).
//   The question: is Thursday's elevation uniform across the cycle, or
//   concentrated at particular days-since-last-test? Splitting Thursday by
//   the elapsed-time buckets leaves 22 MUST_TESTs across five cells:
//       0-7    n= 71  musts= 4   5.6%   CI  2.2-13.6%
//       8-14   n= 52  musts= 5   9.6%   CI  4.2-20.6%
//       15-21  n= 36  musts= 3   8.3%   CI  2.9-21.8%
//       22-30  n= 29  musts= 3  10.3%   CI  3.6-26.4%
//       31+    n= 30  musts= 7  23.3%   CI 11.8-40.9%
//   Every interval overlaps every other one. The CIs are 11 to 29 points
//   wide against an effect worth detecting of a few points, so this is NOT a
//   null result — it is no result. Do not cite these cells as evidence in
//   either direction, and be especially wary of the 31+ cell: 7 events, and
//   the same long-gap users who dominate the interval tail reappear in it.
//   Thursday's hazard does sit above the other-days column in all five
//   buckets, which is CONSISTENT WITH uniform elevation — that is a direction,
//   not a finding, and it must not be reported as one. Distinguishing uniform
//   from concentrated needs several times this many Thursday events.
//
//   MEDIAN-SPACING CLASSIFICATION — held 2026-09-04, not rejected, but WEAKER
//   than it first looked. Only 8 of 23 users have the >= 3 intervals it needs,
//   so 15 would see nothing. And on the canonical set the medians do not fall
//   into clean groups: 8, 13, 16.5, 21, 24, 24.5, 25.5, 36 — a continuous
//   spread with no natural break, where an earlier smaller set appeared to
//   show a ~8-16d cluster and a ~21-36d one. Any cut point would be chosen,
//   not found. Revisit when coverage improves. NOTE no user is "regular": the
//   lowest observed CV is 0.43, so a regular/irregular taxonomy would have an
//   empty middle class.

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

  // ---- WEEKDAY, UPWARD ONLY (2026-09-04) ----
  //
  // The county's MUST_TEST rate genuinely varies by weekday. Measured over
  // 2,054 calls, with a FLAT denominator (we dial 207-214 times on every day
  // of the week, so this is the county's behaviour and not our sampling):
  //
  //     Mon 5.2%   Tue 4.7%   Wed 7.7%   Thu 10.6%
  //     Fri 4.7%   Sat 1.4%   Sun 0.0% (0 of 208)      overall 4.9%
  //     chi-square 32.28, df=6, crit 12.59  ->  p < 0.001
  //
  // This function returns ONLY days whose rate is ABOVE the overall rate and
  // which clear a Bonferroni-corrected per-day test. It can never return a
  // low day, and it deliberately does not return the seven-day distribution
  // at all.
  //
  // READ THIS BEFORE "IMPROVING" IT BY SHOWING THE FULL GRADIENT.
  // The distribution is asymmetric in what it is allowed to say. "Thursday is
  // the most common test day" raises readiness and costs a user nothing if it
  // is wrong. "Sunday is 0 of 208" lowers readiness — and a user who reads
  // that, relaxes, and gets called on a Sunday was failed by this app. Sunday
  // has not been observed in 208 tries; that is not the same as safe, and no
  // sample size makes it the same. This product exists to refuse exactly that
  // inference. So the low half of a real, statistically significant
  // distribution is deliberately discarded, and returning it is not a missing
  // feature — it is the bug this shape prevents.
  //
  // The counts are the county pool, not one person: a single user has nowhere
  // near enough tests to earn a weekday claim (see DAY_GRID_MIN_TESTS).
  var DAY_RATE_MIN_TOTAL_TESTS = 30;   // pooled MUST_TESTs before any claim
  var DAY_RATE_MIN_CALLS_PER_DAY = 60; // denominator floor for one weekday
  // One-sided normal critical value at 0.05/7 (Bonferroni over 7 weekdays).
  // Conservative on purpose: this only ever raises an alarm, so a false
  // positive costs a user a wasted-but-safe day of readiness, while a
  // careless threshold spends the credibility of every future warning.
  var Z_DAY_BONFERRONI = 2.45;

  // dayMusts / dayCalls: 7-element arrays indexed 0=Sunday..6=Saturday,
  // MUST_TEST count and TOTAL answered calls for that weekday.
  function countyElevatedDays(dayMusts, dayCalls) {
    var musts = dayMusts || [], calls = dayCalls || [];
    if (musts.length !== 7 || calls.length !== 7) {
      return { show: false, days: [], overallRate: null, reason: 'no weekday data' };
    }
    var totalM = 0, totalC = 0;
    for (var i = 0; i < 7; i++) { totalM += musts[i] || 0; totalC += calls[i] || 0; }
    if (totalM < DAY_RATE_MIN_TOTAL_TESTS || totalC <= 0) {
      return { show: false, days: [], overallRate: null,
               reason: totalM + ' pooled tests, need ' + DAY_RATE_MIN_TOTAL_TESTS };
    }
    var p = totalM / totalC;

    // The whole-week test has to clear first. Without it, the single largest
    // of seven days is just the largest of seven noisy numbers.
    //
    // FULL 2x7 PEARSON, not the event-only goodness-of-fit form. The loop
    // below sums deviations across the MUST_TEST counts alone; the design is
    // actually a contingency table, MUST_TEST vs not, across seven days, and
    // the "not called" cell carries information too. Within each day its
    // deviation is the NEGATIVE of the called one, so each day contributes
    //     (m - n*p)^2/(n*p) * [1 + p/(1-p)]
    // and the bracket is exactly 1/(1-p). Hence the divide: it is an
    // identity, not an approximation or a correction factor.
    //
    // Corrected 2026-09-05 (see the §4.10 correction). The event-only form
    // UNDERSTATES — on the canonical pool 39.659 where the full statistic is
    // 41.623 — so the old code was conservative: it made this gate harder to
    // pass and could only ever have suppressed a real pattern, never invented
    // one. Nothing about the current outcome changes. The PER-DAY test below
    // was already correct: (m - n*p)/sqrt(n*p*(1-p)) is the binomial form.
    var chi2ev = 0;
    for (var d = 0; d < 7; d++) {
      var exp = (calls[d] || 0) * p;
      if (exp > 0) chi2ev += Math.pow((musts[d] || 0) - exp, 2) / exp;
    }
    var chi2 = p < 1 ? chi2ev / (1 - p) : chi2ev;
    if (chi2 <= CHI2_CRIT_DF6_P05) {
      return { show: false, days: [], overallRate: p,
               reason: 'no significant weekday pattern (chi2 ' + chi2.toFixed(1) + ')' };
    }

    var out = [];
    for (var k = 0; k < 7; k++) {
      var c = calls[k] || 0, m = musts[k] || 0;
      if (c < DAY_RATE_MIN_CALLS_PER_DAY) continue;
      var rate = m / c;
      if (rate <= p) continue;                       // UPWARD ONLY
      var expK = c * p;
      var z = (m - expK) / Math.sqrt(expK * (1 - p));
      if (z < Z_DAY_BONFERRONI) continue;
      // count + opportunities on EVERY entry: a rate can never be shown
      // without its denominator. NO lift/timesAverage — §4.10 bans a
      // multiplier by name, because one computed from an underpowered
      // contrast overstates the effect and reads as more precise than the
      // evidence supports.
      out.push({ day: k, rate: Math.round(rate * 1000) / 1000, count: m, opportunities: c });
    }
    out.sort(function(a, b) { return b.rate - a.rate; });
    // Belt and braces: nothing at or below the overall rate may leave here,
    // however the loop above is later edited.
    out = out.filter(function(x) { return x.rate > p; });
    return {
      show: out.length > 0,
      days: out,
      overallRate: Math.round(p * 1000) / 1000,
      reason: out.length ? null : 'no single day clears the per-day test'
    };
  }

  // The NARROWEST contiguous day range containing at least `mass` of the
  // pooled intervals — §4.10 `countyDaily.gapBand`.
  //
  // Not the central band. On a right-skewed distribution the two differ
  // substantially: on the canonical pool the shortest 80% band is 4-32 days
  // (width 28) against a central 6-47 (width 41), a 32% reduction at the
  // same nominal mass. Trimming 10% off each tail is the wrong shape for a
  // distribution that is not symmetric — the long right tail is what the
  // central band spends its width on.
  //
  // Endpoints are OBSERVED values, so the band is always a range the county
  // has actually produced. Ties at the upper edge are absorbed for free:
  // extending through equal values adds coverage without adding width.
  //
  // `mass` is the NOMINAL CONSTRUCTION PARAMETER and nothing here measures
  // coverage. Leave-one-out validates the PROCEDURE (build on n-1, test the
  // held-out one) at roughly 3 points of optimism, with a bootstrap range
  // too wide for any figure finer than "mid-70s" — which is why no coverage
  // number is returned and why §4.10 forbids presenting `mass` as one.
  function shortestBandOf(intervalsByUser, mass) {
    var users = (intervalsByUser || []).filter(function(iv) { return iv && iv.length; });
    var pool = [];
    users.forEach(function(iv) { iv.forEach(function(d) { if (d > 0) pool.push(d); }); });
    if (pool.length < COUNTY_POOL_MIN_INTERVALS || users.length < COUNTY_POOL_MIN_USERS) return null;
    pool.sort(function(a, b) { return a - b; });
    var n = pool.length;
    var need = Math.ceil((mass || COUNTY_RANGE_MASS) * n);
    if (need > n) need = n;
    var best = null;
    for (var i = 0; i + need - 1 < n; i++) {
      var lo = pool[i], hi = pool[i + need - 1];
      var j = i + need - 1;
      while (j + 1 < n && pool[j + 1] === hi) j++;   // free coverage from ties
      var w = hi - lo;
      if (best === null || w < best.w || (w === best.w && (j - i + 1) > best.contained)) {
        best = { lo: lo, hi: hi, w: w, contained: j - i + 1 };
      }
    }
    if (!best) return null;
    return {
      lowDays: best.lo,
      highDays: best.hi,
      mass: mass || COUNTY_RANGE_MASS,
      basedOnIntervals: n,
      basedOnUsers: users.length
    };
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
    countyElevatedDays: countyElevatedDays,
    shortestBandOf: shortestBandOf,
    countyRangeOf: countyRangeOf,
    DAY_GRID_MIN_TESTS: DAY_GRID_MIN_TESTS,
    COUNTY_POOL_MIN_INTERVALS: COUNTY_POOL_MIN_INTERVALS,
    COUNTY_POOL_MIN_USERS: COUNTY_POOL_MIN_USERS
  };
})(typeof window !== 'undefined' ? window : this);
