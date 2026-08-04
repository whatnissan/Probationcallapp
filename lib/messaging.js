// Shared message formatting for anything sent to users in bulk.
//
// Used by BOTH the existing mass texter and the new mass mailer, so a message
// composed once cannot come out polished on one channel and broken on the
// other. Pure functions, no I/O — unit-tested in test/messaging.test.js.

var BRAND_LINE = '- ProbationCall.com';

// ---------------------------------------------------------------- entities
var ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…'
};
function decodeEntities(s) {
  return String(s).replace(/&(amp|lt|gt|quot|#39|apos|nbsp|mdash|ndash|hellip);/g, function(m) {
    return ENTITIES[m] !== undefined ? ENTITIES[m] : m;
  });
}

// ------------------------------------------------- email-shaped detection
// Catches content pasted from an email draft before it goes out as a text.
// Returns reasons rather than a bare boolean so the UI can say WHAT is wrong.
function looksLikeEmailContent(input) {
  var s = String(input || '');
  var reasons = [];
  if (/^\s*subject\s*:/im.test(s)) reasons.push('starts with a "Subject:" line');
  if (/<\/?(p|div|br|span|table|tr|td|a|h[1-6]|strong|em|ul|ol|li|img)\b[^>]*>/i.test(s)) reasons.push('contains HTML tags');
  if (/&(amp|lt|gt|quot|#39|nbsp);/i.test(s)) reasons.push('contains HTML entities');
  if (/^\s{0,3}#{1,6}\s+\S/m.test(s)) reasons.push('contains markdown headings');
  if (/\*\*[^*\n]+\*\*|__[^_\n]+__/.test(s)) reasons.push('contains markdown bold');
  if (/\[[^\]\n]+\]\([^)\s]+\)/.test(s)) reasons.push('contains markdown links');
  if (/^\s{0,3}>\s+\S/m.test(s)) reasons.push('contains blockquotes');
  // A wall of prose with no break reads fine in email and badly on a phone.
  var longestRun = s.split(/\n+/).reduce(function(m, line) { return Math.max(m, line.length); }, 0);
  if (longestRun > 320) reasons.push('has a ' + longestRun + '-character paragraph with no line break');
  return { isEmailShaped: reasons.length > 0, reasons: reasons };
}

// ------------------------------------------------------------ SMS cleanup
// Produces exactly what the handset will show. Idempotent: running it twice
// yields the same string, so a re-preview never double-brands.
function toSmsText(input, brandLine) {
  var brand = brandLine === undefined ? BRAND_LINE : brandLine;
  var s = String(input || '');

  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/^\s*subject\s*:.*$/im, '');            // drop a Subject: line
  s = s.replace(/<br\s*\/?>/gi, '\n');                  // <br> becomes a break
  s = s.replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n');    // block ends break
  s = s.replace(/<[^>]+>/g, '');                        // strip remaining tags
  s = decodeEntities(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2');  // md links
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');             // md headings
  s = s.replace(/^\s{0,3}>\s?/gm, '');                  // blockquotes
  s = s.replace(/^\s{0,3}([-*_])\s*\1\s*\1[\s\1]*$/gm, ''); // --- rules
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1');
  s = s.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?]|$)/g, '$1$2');
  s = s.replace(/`{1,3}([^`\n]+)`{1,3}/g, '$1');
  s = s.replace(/[ \t]+$/gm, '');                       // trailing spaces
  s = s.replace(/\n{3,}/g, '\n\n');                     // collapse blank runs
  s = s.trim();

  if (brand) {
    // Strip any branding the author typed so it appears exactly once, however
    // they wrote it (with or without the leading dash).
    var escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var bare = brand.replace(/^-\s*/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp('\\n*\\s*(' + escaped + '|-?\\s*' + bare + ')\\s*$', 'i'), '');
    s = s.trim();
    s = s + '\n\n' + brand;
  }
  return s;
}

// ------------------------------------------------------- SMS segmentation
// GSM-7 basic + extension table. Anything outside it (emoji, curly quotes,
// most accents) forces the whole message to UCS-2 and halves the capacity.
var GSM7_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
var GSM7_EXTENDED = '^{}\\[~]|€';

function smsSegmentInfo(text) {
  var s = String(text || '');
  var chars = Array.from(s);           // surrogate-pair safe
  var gsm = true, units = 0;
  for (var i = 0; i < chars.length; i++) {
    var c = chars[i];
    if (GSM7_BASIC.indexOf(c) >= 0) { units += 1; }
    else if (GSM7_EXTENDED.indexOf(c) >= 0) { units += 2; }  // escape + char
    else { gsm = false; break; }
  }
  if (!gsm) {
    // UCS-2 counts UTF-16 code units; an emoji is a surrogate pair = 2.
    units = s.length;
  }
  var single = gsm ? 160 : 70;
  var concat = gsm ? 153 : 67;
  var segments = units <= single ? (units === 0 ? 0 : 1) : Math.ceil(units / concat);
  return {
    encoding: gsm ? 'GSM-7' : 'UCS-2',
    characters: chars.length,
    billableUnits: units,
    segments: segments,
    perSegment: segments <= 1 ? single : concat,
    remainingInLast: segments === 0 ? single : (segments * (segments <= 1 ? single : concat)) - units
  };
}

// ------------------------------------------------------- branded email HTML
function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Body is authored as plain text. Blank-line-separated blocks become
// paragraphs; single newlines become <br>. Bare URLs are linkified. Table
// layout throughout — CLAUDE.md rule 4, Gmail mobile mangles divs.
function renderBrandedEmail(opts) {
  opts = opts || {};
  var subject = String(opts.subject || '').trim();
  var raw = String(opts.body || '').replace(/\r\n?/g, '\n').trim();
  var logo = opts.logoUrl || 'https://i.imgur.com/6ZPpeQW.png';

  var blocks = raw.split(/\n{2,}/).filter(function(b) { return b.trim().length; });
  var bodyHtml = blocks.map(function(b) {
    var withBreaks = escapeHtml(b.trim()).replace(/\n/g, '<br>');
    withBreaks = withBreaks.replace(/(https?:\/\/[^\s<]+)/g,
      '<a href="$1" style="color:#0b7285;text-decoration:underline">$1</a>');
    return '<p style="margin:0 0 16px;color:#18181b;font-size:16px;line-height:1.6;">' + withBreaks + '</p>';
  }).join('');

  var html = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#f4f4f5;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;padding:24px 0;">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e4e4e7;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">' +
    '<tr><td align="center" style="background:#ffffff;padding:24px 24px 8px;">' +
    '<img src="' + escapeHtml(logo) + '" alt="ProbationCall" width="150" style="width:150px;max-width:60%;height:auto;display:block;border:0;">' +
    '</td></tr>' +
    (subject ? '<tr><td style="padding:8px 32px 0;"><h1 style="margin:0 0 12px;color:#0a0a1a;font-size:21px;line-height:1.3;font-weight:700;">' + escapeHtml(subject) + '</h1></td></tr>' : '') +
    '<tr><td style="padding:8px 32px 24px;">' + bodyHtml + '</td></tr>' +
    '<tr><td style="background:#fafafa;border-top:1px solid #e4e4e7;padding:18px 32px;text-align:center;">' +
    '<a href="https://probationcall.com" style="color:#0b7285;text-decoration:none;font-size:14px;font-weight:600;">probationcall.com</a>' +
    '<div style="color:#71717a;font-size:12px;line-height:1.5;margin-top:6px;">Daily probation hotline checks, handled for you.</div>' +
    '</td></tr></table></td></tr></table></body></html>';

  // Plain-text alternative so text-only clients don't show a blank message.
  var text = (subject ? subject + '\n\n' : '') + raw + '\n\n—\nprobationcall.com';

  return { html: html, text: text, subject: subject };
}

module.exports = {
  BRAND_LINE: BRAND_LINE,
  looksLikeEmailContent: looksLikeEmailContent,
  toSmsText: toSmsText,
  smsSegmentInfo: smsSegmentInfo,
  renderBrandedEmail: renderBrandedEmail,
  escapeHtml: escapeHtml
};
