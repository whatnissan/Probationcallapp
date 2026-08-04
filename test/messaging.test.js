const test = require('node:test');
const assert = require('node:assert');

const {
  BRAND_LINE, looksLikeEmailContent, toSmsText, smsSegmentInfo, renderBrandedEmail
} = require('../lib/messaging');

// ---------------------------------------------------------- toSmsText
test('toSmsText: appends branding exactly once', function() {
  const out = toSmsText('We are live.');
  assert.strictEqual(out, 'We are live.\n\n- ProbationCall.com');
});

test('toSmsText: does not duplicate branding the author already typed', function() {
  assert.strictEqual(toSmsText('We are live.\n\n- ProbationCall.com'), 'We are live.\n\n- ProbationCall.com');
  assert.strictEqual(toSmsText('We are live.\n\nProbationCall.com'), 'We are live.\n\n- ProbationCall.com');
  assert.strictEqual(toSmsText('We are live.\n\n-ProbationCall.com'), 'We are live.\n\n- ProbationCall.com');
});

test('toSmsText: is idempotent', function() {
  const once = toSmsText('Service is live today.');
  assert.strictEqual(toSmsText(once), once);
  assert.strictEqual(toSmsText(toSmsText(once)), once);
});

test('toSmsText: strips a Subject: line', function() {
  assert.strictEqual(toSmsText('Subject: We are live\nWe are live now.'), 'We are live now.\n\n- ProbationCall.com');
});

test('toSmsText: strips HTML and decodes entities', function() {
  // </p> ends a block and <br> adds a break, so the two together are a
  // paragraph gap — that is the right shape for a text message.
  assert.strictEqual(
    toSmsText('<p>Tom &amp; Jerry</p><br><div>Second line</div>'),
    'Tom & Jerry\n\nSecond line\n\n- ProbationCall.com'
  );
  // A single <br> is a soft break, not a paragraph.
  assert.strictEqual(
    toSmsText('Line one<br>Line two'),
    'Line one\nLine two\n\n- ProbationCall.com'
  );
});

test('toSmsText: flattens markdown', function() {
  assert.strictEqual(toSmsText('# Heading\n**bold** and _italic_'), 'Heading\nbold and italic\n\n- ProbationCall.com');
  assert.strictEqual(toSmsText('See [our site](https://probationcall.com) now'),
    'See our site https://probationcall.com now\n\n- ProbationCall.com');
  assert.strictEqual(toSmsText('> quoted line'), 'quoted line\n\n- ProbationCall.com');
});

test('toSmsText: collapses runs of blank lines and trailing spaces', function() {
  assert.strictEqual(toSmsText('a   \n\n\n\n\nb'), 'a\n\nb\n\n- ProbationCall.com');
});

test('toSmsText: brandLine can be disabled', function() {
  assert.strictEqual(toSmsText('plain', ''), 'plain');
});

// ------------------------------------------------ looksLikeEmailContent
test('looksLikeEmailContent: flags email-shaped input with reasons', function() {
  const r = looksLikeEmailContent('Subject: Hello\n<p>Hi <strong>there</strong></p>');
  assert.strictEqual(r.isEmailShaped, true);
  assert.ok(r.reasons.some(x => /Subject:/.test(x)));
  assert.ok(r.reasons.some(x => /HTML tags/.test(x)));
});

test('looksLikeEmailContent: flags an unbroken wall of prose', function() {
  const r = looksLikeEmailContent('x'.repeat(400));
  assert.strictEqual(r.isEmailShaped, true);
  assert.ok(r.reasons.some(x => /line break/.test(x)));
});

test('looksLikeEmailContent: clean SMS copy passes', function() {
  const r = looksLikeEmailContent('We are live. Your daily checks start tomorrow at 6:30 AM.');
  assert.strictEqual(r.isEmailShaped, false);
  assert.deepStrictEqual(r.reasons, []);
});

// -------------------------------------------------------- segmentation
test('smsSegmentInfo: GSM-7 boundaries', function() {
  assert.strictEqual(smsSegmentInfo('').segments, 0);
  const at160 = smsSegmentInfo('a'.repeat(160));
  assert.strictEqual(at160.encoding, 'GSM-7');
  assert.strictEqual(at160.segments, 1);
  const at161 = smsSegmentInfo('a'.repeat(161));
  assert.strictEqual(at161.segments, 2);   // 153 per concatenated segment
});

test('smsSegmentInfo: an emoji forces UCS-2 and halves capacity', function() {
  const info = smsSegmentInfo('Test required 🚨');
  assert.strictEqual(info.encoding, 'UCS-2');
  assert.strictEqual(info.segments, 1);
  assert.strictEqual(smsSegmentInfo('🚨' + 'a'.repeat(70)).segments, 2);
});

test('smsSegmentInfo: GSM-7 extended chars cost two units', function() {
  // '€' is in the GSM-7 extension table: 1 char, 2 billable units.
  const info = smsSegmentInfo('€');
  assert.strictEqual(info.encoding, 'GSM-7');
  assert.strictEqual(info.characters, 1);
  assert.strictEqual(info.billableUnits, 2);
});

test('smsSegmentInfo: a typical branded announcement stays in one segment', function() {
  const body = toSmsText('ProbationCall is live. Your daily hotline check runs every morning and we text you the result.');
  assert.ok(smsSegmentInfo(body).segments <= 1, 'expected 1 segment, got ' + smsSegmentInfo(body).segments);
});

// ------------------------------------------------------- branded email
test('renderBrandedEmail: escapes user content in the HTML part', function() {
  const out = renderBrandedEmail({ subject: 'Hi <script>', body: 'Tom & Jerry <img src=x>' });
  assert.ok(out.html.indexOf('<script>') === -1, 'raw script tag leaked into HTML');
  assert.ok(out.html.indexOf('&lt;script&gt;') > -1);
  assert.ok(out.html.indexOf('Tom &amp; Jerry') > -1);
});

test('renderBrandedEmail: paragraphs, line breaks and links', function() {
  const out = renderBrandedEmail({ subject: 'S', body: 'One\nTwo\n\nThree https://probationcall.com' });
  assert.ok(out.html.indexOf('One<br>Two') > -1, 'single newline should become <br>');
  assert.ok((out.html.match(/<p /g) || []).length === 2, 'blank line should start a new paragraph');
  assert.ok(out.html.indexOf('<a href="https://probationcall.com"') > -1, 'bare URL should linkify');
});

test('renderBrandedEmail: always produces a plain-text alternative', function() {
  const out = renderBrandedEmail({ subject: 'Subject here', body: 'Body here' });
  assert.ok(out.text.indexOf('Subject here') > -1);
  assert.ok(out.text.indexOf('Body here') > -1);
  assert.ok(out.text.indexOf('probationcall.com') > -1);
  assert.ok(out.text.indexOf('<') === -1, 'text part must contain no markup');
});

test('renderBrandedEmail: table-based layout, per CLAUDE.md rule 4', function() {
  const out = renderBrandedEmail({ subject: 'S', body: 'B' });
  assert.ok(out.html.indexOf('<table') > -1);
  assert.ok(out.html.indexOf('probationcall.com') > -1);
});
