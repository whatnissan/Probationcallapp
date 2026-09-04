// Collapse a User-Agent into one of a fixed set of buckets, for logging.
//
// A raw User-Agent is unbounded attacker-controlled text and a fingerprinting
// surface, so it never reaches a log line. What a log needs is the ANSWER to
// one question — browser, iOS app, known crawler, or script? — and that is a
// small closed set. The two open-ended buckets keep a short slug so an agent
// nobody has seen before is still recognisable; without that, an unknown
// crawler is indistinguishable from any other unknown, which defeats the
// point of logging it at all.
//
// Order matters: the first match wins, so put the specific patterns above
// the general ones. Every bucket name is short and stable — they are grep
// targets in Railway.
var UA_BUCKETS = [
  // AI / data-collection crawlers
  ['grok', /grok/i],
  ['xai', /xai|x-ai\b/i],
  ['gptbot', /gptbot/i],
  ['oai-search', /oai-searchbot/i],
  ['chatgpt-user', /chatgpt-user/i],
  ['claudebot', /claudebot|claude-web|anthropic-ai/i],
  ['ccbot', /ccbot/i],
  ['bytespider', /bytespider/i],
  ['perplexity', /perplexity/i],
  ['diffbot', /diffbot/i],
  // Search + social
  ['googlebot', /googlebot|google-extended/i],
  ['bingbot', /bingbot/i],
  ['applebot', /applebot/i],
  ['amazonbot', /amazonbot/i],
  ['meta', /meta-externalagent|facebookexternalhit|facebookbot/i],
  ['yandex', /yandexbot/i],
  ['baidu', /baiduspider/i],
  // SEO scrapers
  ['semrush', /semrushbot/i],
  ['ahrefs', /ahrefsbot/i],
  ['mj12', /mj12bot/i],
  ['dotbot', /dotbot/i],
  // Our own infrastructure calling us
  ['uptime', /uptimerobot|pingdom|betteruptime|railway/i],
  ['stripe', /^stripe\//i],
  ['twilio', /^twilio/i],
  // OUR iOS APP. Checked before the generic Darwin/CFNetwork patterns
  // because URLSession sends those too, and "which client is looping" is
  // the question this whole bucket list exists to answer.
  ['ios-app', /probationcall/i],
  ['ios-urlsession', /cfnetwork|darwin/i],
  // Hand tools and libraries
  ['curl', /^curl\//i],
  ['wget', /^wget/i],
  ['script', /python-requests|scrapy|aiohttp|httpx|go-http-client|okhttp|java\/|libwww|node-fetch|axios|got\//i],
  ['headless', /headlesschrome|puppeteer|playwright|phantomjs|selenium/i]
];

// First run of word characters, capped. Never the whole string: the point is
// to recognise an agent across log lines, not to reproduce it.
function uaSlug(ua) {
  var m = String(ua === undefined || ua === null ? '' : ua).match(/[A-Za-z0-9_.-]+/);
  return m ? m[0].slice(0, 20) : 'x';
}

function uaBucket(ua) {
  var s = String(ua === undefined || ua === null ? '' : ua);
  if (!s) return 'none';
  for (var i = 0; i < UA_BUCKETS.length; i++) {
    if (UA_BUCKETS[i][1].test(s)) return UA_BUCKETS[i][0];
  }
  // Self-declared bot that is not on the list — keep a slug, it is new.
  if (/bot|crawler|spider|scrape|fetch/i.test(s)) return 'bot?:' + uaSlug(s);
  // A desktop/mobile browser UA is the overwhelming majority and says
  // nothing useful, so it stays one bucket. Everything else keeps a slug —
  // that is where an unidentified client lands, and it is the bucket to
  // read when the question is "what IS that thing".
  if (/^mozilla\/5\.0/i.test(s)) return 'browser';
  return 'ua?:' + uaSlug(s);
}

module.exports = { uaBucket: uaBucket, uaSlug: uaSlug, UA_BUCKETS: UA_BUCKETS };
