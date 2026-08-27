// Test Frequency card builders — pure functions (payload in, HTML string
// out), shared by dashboard.html and the landing-page preview card so the
// marketing demo renders through the SAME code as the product. §4.11a binds:
// single-hue cyan intensity for frequency, slate->amber->red for the
// days-since ratio, green never.

function buildTestTimeline(recentTests, daysSince, availWidth) {
  var pts = recentTests.map(function(iso) { return new Date(iso + "T12:00:00"); });
  var gaps = [];
  for (var i = 1; i < pts.length; i++) gaps.push(Math.round((pts[i] - pts[i - 1]) / 86400000));
  var maxGap = Math.max.apply(null, gaps.concat([1]));
  var PAD = 42, TAIL = 58, H = 126, RY = 66;
  var totalDays = gaps.reduce(function(a, b) { return a + b; }, 0) + Math.max(0, daysSince);
  // One scale for the whole chart: fit the container when possible
  // (px/day between 2.5 and 7), scroll only below the legibility floor.
  var PX = 7;
  if (availWidth && totalDays > 0) {
    PX = Math.min(7, Math.max(2.5, (availWidth - PAD - TAIL) / totalDays));
  }
  var xs = [PAD];
  gaps.forEach(function(g) { xs.push(xs[xs.length - 1] + g * PX); });
  var xToday = xs[xs.length - 1] + Math.max(0, daysSince) * PX;
  var w = Math.ceil(xToday + TAIL);
  var s = "<svg width='" + w + "' height='" + H + "' style='display:block'>";
  for (var gd = 0; gd <= totalDays; gd += 7) {
    var gx = PAD + gd * PX;
    s += "<line x1='" + gx + "' y1='30' x2='" + gx + "' y2='" + (H - 22) + "' stroke='rgba(255,255,255,0.045)' stroke-width='1'/>";
  }
  s += "<defs><linearGradient id='railGrad' x1='0' y1='0' x2='1' y2='0'>" +
    "<stop offset='0' stop-color='rgba(0,217,255,0.18)'/><stop offset='1' stop-color='rgba(0,217,255,0.55)'/></linearGradient></defs>";
  s += "<line x1='" + PAD + "' y1='" + RY + "' x2='" + xs[xs.length - 1] + "' y2='" + RY + "' stroke='url(#railGrad)' stroke-width='3' stroke-linecap='round'/>";
  gaps.forEach(function(g, i) {
    var rel = g / maxGap;
    s += "<line x1='" + xs[i] + "' y1='" + RY + "' x2='" + xs[i + 1] + "' y2='" + RY + "' stroke='rgba(0,217,255," + (0.18 + rel * 0.5).toFixed(2) + ")' stroke-width='" + (2 + rel * 5).toFixed(1) + "' stroke-linecap='round'/>";
    var mid = (xs[i] + xs[i + 1]) / 2;
    s += "<text x='" + mid + "' y='" + (RY - 24) + "' text-anchor='middle' font-size='11' fill='#94a3c0'>+" + g + "d</text>";
  });
  s += "<line x1='" + xs[xs.length - 1] + "' y1='" + RY + "' x2='" + xToday + "' y2='" + RY + "' stroke='rgba(245,158,11,0.5)' stroke-width='2' stroke-dasharray='4 5'/>";
  var lastLabelEnd = -1e9, lastRow = 0;
  pts.forEach(function(p, i) {
    var label = p.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    s += "<g><title>Test required — " + label + "</title>" +
      "<circle cx='" + xs[i] + "' cy='" + RY + "' r='11' fill='rgba(0,217,255,0.10)'/>" +
      "<circle cx='" + xs[i] + "' cy='" + RY + "' r='7' fill='none' stroke='rgba(0,217,255,0.45)' stroke-width='1.5'/>" +
      "<circle cx='" + xs[i] + "' cy='" + RY + "' r='4.5' fill='#00d9ff'/></g>";
    // Stagger date labels onto a second row when neighbors would collide —
    // colliding text is worse than an extra 13px of height.
    // Centers closer than ~46px collide at 11px type; alternate rows.
    var row = 0;
    if (xs[i] - lastLabelEnd < 46 && lastRow === 0) row = 1;
    var ly = row === 0 ? H - 18 : H - 5;
    s += "<text x='" + xs[i] + "' y='" + ly + "' text-anchor='middle' font-size='11' fill='#94a3c0'>" + label + "</text>";
    lastLabelEnd = xs[i];
    lastRow = row;
  });
  s += "<g><title>Today — " + daysSince + " days since your last test</title>" +
    "<circle cx='" + xToday + "' cy='" + RY + "' r='6' fill='none' stroke='#f59e0b' stroke-width='2'/>" +
    "<circle cx='" + xToday + "' cy='" + RY + "' r='2' fill='#f59e0b'/></g>";
  // The today label always right-anchors (w is always xToday+TAIL), so it
  // extends leftward and can land on the last "+Nd" gap label once the
  // scale compresses. Lift it a row only when they actually overlap \u2014
  // measured, not assumed, so a roomy chart renders exactly as before.
  var todayLabel = "today \u00b7 " + daysSince + "d";
  var todayLeft = xToday + 10 - todayLabel.length * 6;
  var lastGapRight = -1e9;
  if (gaps.length) {
    lastGapRight = (xs[xs.length - 2] + xs[xs.length - 1]) / 2 + ("+" + gaps[gaps.length - 1] + "d").length * 3;
  }
  var todayY = (todayLeft - lastGapRight < 6) ? RY - 38 : RY - 24;
  s += "<text x='" + Math.min(xToday + 10, w - 4) + "' y='" + todayY + "' text-anchor='" + (xToday + 70 > w ? "end" : "start") + "' font-size='11' font-weight='600' fill='#f59e0b'>" + todayLabel + "</text>";
  return "<div style='overflow-x:auto;max-width:100%'>" + s + "</svg></div>";
}

// Weekday chart: tall rounded cells, count INSIDE, day letter beneath,
// single-hue intensity ramp with the dominant cell bordered. Counts wear ink
// colors, never the series hue; weekends render low, never absent.
function buildWeekdayVisual(county, counts) {
  if (counts && counts.length === 7) {
    var mx = Math.max.apply(null, counts);
    var names = ["S", "M", "T", "W", "T", "F", "S"], cells = "";
    for (var i = 0; i < 7; i++) {
      var rel = mx > 0 ? counts[i] / mx : 0;
      var alpha = (0.08 + rel * 0.72).toFixed(2);
      var ink = rel > 0.55 ? "#001018" : "#dbe3f0";
      var border = counts[i] === mx ? "1.5px solid rgba(0,217,255,0.65)" : "1px solid rgba(255,255,255,0.07)";
      cells += "<div style='display:flex;flex-direction:column;align-items:center;gap:4px'>" +
        "<div title='" + counts[i] + " of " + county.total + " tests' style='width:40px;height:52px;border-radius:9px;border:" + border + ";display:flex;align-items:center;justify-content:center;font-size:0.95rem;font-weight:700;background:rgba(0,217,255," + alpha + ");color:" + ink + ";box-shadow:inset 0 1px 0 rgba(255,255,255,0.06)'>" + counts[i] + "</div>" +
        "<div style='font-size:0.68rem;color:#94a3c0'>" + names[i] + "</div></div>";
    }
    return "<div style='display:flex;gap:7px;margin:10px 0 3px;flex-wrap:wrap'>" + cells + "</div>" +
      "<div style='font-size:0.68rem;color:#7d8aa8'>tests recorded per day of week \u00b7 darker = more often \u00b7 no day is safe</div>";
  }
  // Fallback split bar: both segments labeled ON the bar, weekend block
  // fixed-width so 2-of-72 is visible, never a hairline.
  var wk = county.total - county.weekendCount;
  return "<div style='display:flex;height:22px;border-radius:6px;overflow:hidden;margin:10px 0 3px;font-size:0.68rem;font-weight:600'>" +
    "<div style='flex:1;background:rgba(0,217,255,0.55);display:flex;align-items:center;padding-left:8px;color:#001018'>" + wk + " weekdays</div>" +
    "<div style='width:92px;background:rgba(0,217,255,0.14);display:flex;align-items:center;justify-content:center;color:#dbe3f0'>" + county.weekendCount + " weekends</div></div>" +
    "<div style='font-size:0.68rem;color:#7d8aa8'>no day is safe</div>";
}

// Days-since gauge: the ring WRAPS the number, so the number is its own
// label. Fill = daysSince / average gap; past 1.0x the fill overflows onto
// an outer lap. Ramp is dark slate -> amber -> red per 4.11a — NEVER green:
// green at day 3 says "you're clear", and a person can be tested on day 3.
// A tick at the top marks the 1.0x ("your usual gap") landmark.
function buildDaysGauge(daysSince, avg) {
  var size = 76, c = size / 2, R = 27, TRACK = 5;
  var ratio = avg ? daysSince / avg : null;
  var color = ratio === null ? '#8892b0' : ratio >= 1 ? '#ef4444' : ratio >= 0.7 ? '#f59e0b' : 'rgba(136,146,176,0.95)';
  var C = 2 * Math.PI * R;
  var frac1 = ratio === null ? 0 : Math.min(1, ratio);
  var s = "<svg width='" + size + "' height='" + size + "'>";
  s += "<title>" + (ratio !== null ? ratio.toFixed(1) + "\u00d7 your usual gap between tests" : "days since your last test") + "</title>";
  s += "<circle cx='" + c + "' cy='" + c + "' r='" + R + "' fill='none' stroke='rgba(255,255,255,0.08)' stroke-width='" + TRACK + "'/>";
  s += "<circle cx='" + c + "' cy='" + c + "' r='" + R + "' fill='none' stroke='" + color + "' stroke-width='" + TRACK + "' stroke-linecap='round' stroke-dasharray='" + (C * frac1).toFixed(1) + " " + C.toFixed(1) + "' transform='rotate(-90 " + c + " " + c + ")'/>";
  if (ratio !== null && ratio > 1) {
    var R2 = R + 5, C2 = 2 * Math.PI * R2, frac2 = Math.min(1, ratio - 1);
    s += "<circle cx='" + c + "' cy='" + c + "' r='" + R2 + "' fill='none' stroke='#ef4444' stroke-width='2.5' stroke-linecap='round' stroke-dasharray='" + (C2 * frac2).toFixed(1) + " " + C2.toFixed(1) + "' transform='rotate(-90 " + c + " " + c + ")' opacity='0.85'/>";
  }
  s += "<line x1='" + c + "' y1='" + (c - R - 7) + "' x2='" + c + "' y2='" + (c - R + 4) + "' stroke='rgba(255,255,255,0.5)' stroke-width='2'/>";
  s += "<text x='" + c + "' y='" + (c + 7) + "' text-anchor='middle' font-size='21' font-weight='700' fill='#fff'>" + daysSince + "</text>";
  return s + "</svg>";
}
