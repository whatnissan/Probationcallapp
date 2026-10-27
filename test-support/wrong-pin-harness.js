// Boots the REAL server.js offline for test/wrong-pin-flow.test.js (kept
// outside test/ so `node --test` does not run it on its own): fake Supabase
// in memory, fake Twilio that records each dial's TwiML callback, cron jobs
// captured and fired by hand, a settable clock, and stubbed downloads —
// Twilio's recording returns bytes, Deepgram returns whatever transcript the
// scenario sets. The PIN each dial ENTERS is read back from /twiml/answer,
// so "which PIN was dialled" is observed, not inferred.
// Prints one JSON line of observations and exits.
'use strict';
const Module = require('module'), http = require('http'), https = require('https'), path = require('path');
const REPO = path.join(__dirname, '..');

let NOW = Date.parse('2026-10-28T11:00:00Z');            // 6:00 AM CDT
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  // +1 ms per call: call ids are 'call_' + Date.now(), and a frozen clock
  // would give every dial in one poller tick the same id.
  static now() { NOW += 1; return NOW; }
};
for (const mod of [http, https]) {
  const o = mod.request;
  mod.request = function (opts, ...r) {
    const h = typeof opts === 'string' ? new URL(opts).hostname : (opts.hostname || opts.host);
    if (h && !['localhost', '127.0.0.1', '::1'].includes(h)) throw new Error('blocked ' + h);
    return o.call(this, opts, ...r);
  };
}

const MG = '+19362834848';
const id = (n) => '00000000-0000-4000-8000-0000000000' + String(n).padStart(2, '0');
const U = { W1: id(1), OK: id(2), B3: id(3), FB: id(4), W5: id(5), W2: id(6), W3: id(7), W4: id(8), N1: id(9), W6: id(10), ADMIN: id(11),
  DEMO: id(12), W7: id(13), W8: id(14), PE: id(15), PX: id(16), FS: id(17) };
const NAME = Object.fromEntries(Object.entries(U).map(([k, v]) => [v, k]));
const prof = (uid, extra) => Object.assign({ id: uid, email: uid.slice(-2) + '@example.invalid', credits: 10, is_demo: false, is_admin: false, is_disabled: false, verified_phone: null }, extra || {});
const mgSched = (uid, minute, extra) => Object.assign({ id: 's' + uid.slice(-2), user_id: uid, county: 'montgomery', target_number: MG, pin: '1234' + uid.slice(-2),
  hour: 6, minute: minute, timezone: 'America/Chicago', enabled: true, paused_reason: null, notify_method: 'email', notify_email: uid.slice(-2) + '@example.invalid',
  notify_number: null, notify_push: true, consecutive_pin_expired: 0, consecutive_wrong_pin: 0, created_at: '2026-09-01T00:00:00Z' }, extra || {});

const tables = {
  profiles: [prof(U.W1), prof(U.OK), prof(U.B3), prof(U.FB), prof(U.W5), prof(U.W2), prof(U.W3), prof(U.W4), prof(U.N1), prof(U.W6), prof(U.ADMIN, { is_admin: true }),
    prof(U.DEMO, { is_demo: true }), prof(U.W7), prof(U.W8), prof(U.PE), prof(U.PX), prof(U.FS, { user_color: 'gray' })],
  user_schedules: [
    mgSched(U.W1, 0, { pin: '111101' }), mgSched(U.OK, 5), mgSched(U.B3, 10), mgSched(U.W5, 15),
    mgSched(U.W2, 30), mgSched(U.W3, 31), mgSched(U.W4, 32), mgSched(U.W6, 40), mgSched(U.N1, 45),
    mgSched(U.FB, 20, { county: 'ftbend', ftbend_office: 'missouri', target_number: '+12812383669', pin: null }),
    mgSched(U.ADMIN, 50, { enabled: false, paused_reason: 'user', notify_method: 'sms', notify_number: '+15555550111' }),
    mgSched(U.DEMO, 5, { hour: 5, pin: '000000' }), mgSched(U.W7, 7), mgSched(U.W8, 8, { consecutive_wrong_pin: 1, last_wrong_pin_day: '2026-10-13' }),
    // Paused on an expired PIN before this run, with the pause event the 074
    // trigger would have opened and the call that caused it.
    mgSched(U.PE, 9, { enabled: false, paused_reason: 'pin_expired', consecutive_pin_expired: 2 }),
    // Last expired-PIN morning three weeks ago.
    mgSched(U.PX, 16, { consecutive_pin_expired: 1, last_pin_expired_day: '2026-10-13' }),
    // Paused on a rejected PIN; about to move to Fort Bend and back.
    mgSched(U.FS, 17, { enabled: false, paused_reason: 'wrong_pin', consecutive_wrong_pin: 2, last_wrong_pin_day: '2026-10-21' })
  ],
  pending_retries: [], credit_transactions: [], call_history: [], call_attempts: [], pin_reprompts: [], sms_opt_outs: [], sms_consents: [],
  schema_migrations: [], device_tokens: [], push_deliveries: [], admin_alert_days: [],
  schedule_pause_events: [{ id: 'ev0', user_id: U.PE, reason: 'pin_expired', paused_at: '2026-10-20T12:00:00Z', resumed_at: null },
    { id: 'ev1', user_id: U.FS, reason: 'wrong_pin', paused_at: '2026-10-21T12:00:00Z', resumed_at: null }]
};
tables.call_history.push({ id: 'hPE', user_id: U.PE, county: 'montgomery', result: 'PIN_EXPIRED', pin_used: '123415', created_at: '2026-10-20T12:00:00Z' });
tables.call_history.push({ id: 'hFS', user_id: U.FS, county: 'montgomery', result: 'WRONG_PIN', pin_used: '123417', created_at: '2026-10-21T12:00:00Z' });
let seq = 1;
const iso = () => new RealDate(NOW).toISOString();
function builder(table) {
  const f = []; const orders = []; let op = null, payload = null, single = false, lim = null, head = false, count = false;
  const rows = () => (tables[table] = tables[table] || []);
  const b = new Proxy({}, { get(_t, p) {
    if (p === 'then') return (res, rej) => {
      const match = (r) => f.every((t) => t(r));
      let out;
      if (op === 'insert' && table === 'admin_alert_days') {
        const it = Array.isArray(payload) ? payload[0] : payload;
        if (rows().some((r) => r.alert === it.alert && String(r.day) === String(it.day))) {
          return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "admin_alert_days_pkey"' } }).then(res, rej);
        }
      }
      if (op === 'insert' || op === 'upsert') {
        // Database defaults the real tables have: created_at now(), and
        // call_history.county 'montgomery'.
        const items = (Array.isArray(payload) ? payload : [payload]).map((it) => Object.assign({ id: 'r' + (seq++), created_at: iso() },
          table === 'call_history' ? { county: 'montgomery' } : {}, it));
        if (table === 'user_schedules') items.forEach((it) => pauseTrigger(null, it));
        if (op === 'upsert' && table === 'user_schedules') {
          items.forEach((it) => { const ex = rows().find((r) => r.user_id === it.user_id); if (ex) Object.assign(ex, it); else rows().push(it); });
        } else rows().push(...items);
        out = { data: single ? items[0] : items, error: null };
      } else if (op === 'update') {
        const hit = rows().filter(match);
        hit.forEach((r) => { const next = Object.assign({}, r, payload); if (table === 'user_schedules') pauseTrigger(r, next); Object.assign(r, next); });
        out = { data: hit.map((r) => Object.assign({}, r)), error: null };
      } else if (op === 'delete') {
        const keep = rows().filter((r) => !match(r)); const gone = rows().length - keep.length; tables[table] = keep;
        out = { data: null, error: null, count: gone };
      } else {
        let got = rows().filter(match);
        for (const [c, asc] of orders.slice().reverse()) got = got.slice().sort((x, y) => (x[c] < y[c] ? -1 : x[c] > y[c] ? 1 : 0) * (asc ? 1 : -1));
        const n = got.length;
        if (lim !== null) got = got.slice(0, lim);
        out = single ? { data: got[0] ? Object.assign({}, got[0]) : null, error: null } : { data: head ? null : got.map((r) => Object.assign({}, r)), error: null, count: count ? n : null };
      }
      return Promise.resolve(out).then(res, rej);
    };
    if (['insert', 'update', 'upsert', 'delete'].includes(p)) return (x) => { op = p; payload = x; return b; };
    if (p === 'select') return (_c, o) => { if (o && o.head) head = true; if (o && o.count) count = true; return b; };
    if (p === 'single' || p === 'maybeSingle') return () => { single = true; return b; };
    const cmp = { eq: (a, v) => String(a) === String(v), neq: (a, v) => String(a) !== String(v), lte: (a, v) => a <= v, gte: (a, v) => a >= v, lt: (a, v) => a < v, gt: (a, v) => a > v };
    if (cmp[p]) return (c, v) => { f.push((r) => r[c] !== undefined && r[c] !== null && cmp[p](r[c], v)); return b; };
    if (p === 'is') return (c, v) => { f.push((r) => (r[c] === undefined ? null : r[c]) === v); return b; };
    if (p === 'not') return (c, o, v) => { f.push((r) => !(o === 'is' && (r[c] === undefined ? null : r[c]) === v)); return b; };
    if (p === 'in') return (c, vs) => { f.push((r) => vs.map(String).includes(String(r[c]))); return b; };
    if (p === 'order') return (c, o) => { orders.push([c, !(o && o.ascending === false)]); return b; };
    if (p === 'limit') return (n) => { lim = n; return b; };
    return () => b;
  }});
  return b;
}
// What migrations 074 + 077's trigger does to schedule_pause_events (the SQL
// itself is tested against Postgres; this keeps the fake honest).
function pauseTrigger(old, row) {
  const ev = tables.schedule_pause_events;
  const closeOpen = () => ev.filter((e) => e.user_id === row.user_id && !e.resumed_at).forEach((e) => { e.resumed_at = iso(); });
  if (!old) {
    closeOpen();
    if (row.enabled === false) { row.paused_at = iso(); ev.push({ id: 'ev' + (seq++), user_id: row.user_id, reason: row.paused_reason, paused_at: row.paused_at, resumed_at: null }); }
    else row.paused_at = null;
    return;
  }
  if (row.enabled === false && old.enabled !== false) { row.paused_at = iso(); ev.push({ id: 'ev' + (seq++), user_id: row.user_id, reason: row.paused_reason, paused_at: row.paused_at, resumed_at: null }); }
  else if (row.enabled !== false && old.enabled === false) { row.paused_at = null; closeOpen(); }
  else if (row.enabled === false && old.enabled === false && row.paused_reason !== old.paused_reason) {
    ev.filter((e) => e.user_id === row.user_id && !e.resumed_at).forEach((e) => { e.reason = row.paused_reason; });
  }
}
const P = (uid) => tables.profiles.find((r) => r.id === uid);
const rpc = async (name, a) => {
  if (name === 'deduct_credit_with_ledger') {
    const p = P(a.p_user_id); p.credits -= a.p_amount;
    tables.credit_transactions.push({ id: 'l' + (seq++), user_id: a.p_user_id, amount: -a.p_amount, source: a.p_source || 'call_deduction' });
    return { data: p.credits, error: null };
  }
  if (name === 'add_credits_with_ledger') { const p = P(a.p_user_id); p.credits += a.p_amount; return { data: p.credits, error: null }; }
  return { data: null, error: null };
};
const tokens = { 'tok-w1': U.W1, 'tok-n1': U.N1, 'tok-w8': U.W8, 'tok-pe': U.PE, 'tok-fs': U.FS };
const fake = { from: builder, rpc,
  auth: { getUser: async (t) => tokens[t] ? { data: { user: { id: tokens[t], email: P(tokens[t]).email } }, error: null } : { data: { user: null }, error: { message: 'bad' } },
          admin: new Proxy({}, { get: () => async () => ({ data: null, error: null }) }) },
  storage: { from: () => new Proxy({}, { get: () => async () => ({ data: null, error: null }) }) },
  channel: () => new Proxy({}, { get: () => function () { return this; } }) };

const dials = []; const smsSent = []; const emails = [];
const twilioClient = {
  calls: { create: async (o) => { const callId = new URL(o.url).searchParams.get('callId'); dials.push({ to: o.to, callId }); return { sid: 'CA' + (seq++) }; } },
  messages: { create: async (o) => { smsSent.push({ to: o.to, body: o.body }); return { sid: 'SM' + (seq++), status: 'queued' }; } },
  calls_get: null
};
const twilioFn = new Proxy(function () { return twilioClient; }, { get: (t, k) => k === 'validateRequest' ? () => true : (k === 'twiml' ? require(path.join(REPO, 'node_modules', 'twilio')).twiml : t[k]) });
const fakeApns = { apnsConfigured: () => false, buildPayload: (o) => o, sendPush: async () => ({ ok: false }), sendPushBothEnvironments: async () => ({ ok: false, attempts: [] }) };
const crons = [];
const fakeCron = { schedule: (expr, fn) => { const job = { expr, fn, stopped: false, stop() { this.stopped = true; }, start() {} }; crons.push(job); return job; }, validate: () => true };
const inert = () => new Proxy(function () {}, { get: (t, k) => k === 'then' ? undefined : inert(), apply: () => inert() });
const L = Module._load;
Module._load = function (r, p, m) {
  if (r === 'dotenv') return { config: () => ({}) };
  if (r === '@supabase/supabase-js') return { createClient: () => fake };
  if (r === 'twilio') return twilioFn;
  if (r === 'stripe') return () => inert();
  if (r === 'node-cron') return fakeCron;
  if (/(^|\/)lib\/apns(\.js)?$/.test(r)) return fakeApns;
  return L.apply(this, arguments);
};
let nextTranscript = '';
globalThis.fetch = async (u, o) => {
  u = String(u);
  if (u.includes('brevo')) { const j = JSON.parse(o.body); emails.push({ to: j.to[0].email, subject: j.subject }); return { ok: true, status: 201, json: async () => ({ messageId: 'm' }), text: async () => '' }; }
  if (u.startsWith('https://api.twilio.com/')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4096) };
  if (u.startsWith('https://api.deepgram.com/')) {
    const t = nextTranscript;
    return { ok: true, status: 200, json: async () => ({ results: { channels: [{ alternatives: [{ transcript: t }] }] } }) };
  }
  if (u.includes('finishprobation.com')) return { ok: false, status: 503, text: async () => '' };
  throw new Error('blocked fetch ' + u);
};
Object.assign(process.env, { BASE_URL: 'https://example.invalid', BREVO_KEY: 'x', TWILIO_VALIDATE: 'off', NODE_ENV: 'test', DEEPGRAM_API_KEY: 'x', TWILIO_ACCOUNT_SID: 'AC0', TWILIO_AUTH_TOKEN: 'x' });
console.log = () => {}; console.error = () => {}; console.warn = () => {};
require(path.join(REPO, 'server.js'));

const PROMPT = 'Please enter your ID number followed by the pound sign.';
const REJECTED = 'Welcome. ' + PROMPT + ' ' + PROMPT + ' ' + PROMPT;
const ACCEPTED_NO = 'Welcome. ' + PROMPT + ' Thank you. You do not need to test today. Goodbye.';
const EXPIRED = 'Welcome. ' + PROMPT + ' This ID number has expired. Please contact your probation officer.';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (method, p, body, tok, form) => new Promise((ok) => {
  const s = body ? (form ? new URLSearchParams(body).toString() : JSON.stringify(body)) : '';
  const req = http.request({ host: '127.0.0.1', port: Number(process.env.PORT), path: p, method,
    headers: Object.assign({ 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(s) }, tok ? { Authorization: 'Bearer ' + tok } : {}) },
    (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) { /* xml */ } ok({ status: res.statusCode, body: d, j }); }); });
  req.end(s);
});
const at = (isoStr) => { NOW = Date.parse(isoStr); };
const jobFor = (minute, hour) => crons.filter((c) => c.expr === minute + ' ' + (hour || 6) + ' * * *').pop();
const minuteCron = () => crons.find((c) => c.expr === '* * * * *');
const sched = (uid) => tables.user_schedules.find((r) => r.user_id === uid);
const pending = (uid) => tables.pending_retries.find((r) => r.user_id === uid) || null;
const rowsFor = (uid) => tables.call_history.filter((r) => r.user_id === uid).map((r) => r.result);
const mailTo = (uid) => emails.filter((e) => e.to === uid.slice(-2) + '@example.invalid').map((e) => e.subject);
const charges = (uid) => tables.credit_transactions.filter((t) => t.user_id === uid && t.amount < 0).length;
// What the dial actually ENTERS on the hotline.
async function pinDialled(callId) {
  const r = await call('POST', '/twiml/answer?callId=' + encodeURIComponent(callId), {}, null, true);
  const digits = (/digits="([^"]+)"/.exec(r.body) || [])[1] || '';
  return (/^w+1w+(\d+)w+1$/.exec(digits) || [])[1] || null;
}
let recN = 0;
async function hear(dial, transcript) {
  if (!dial) return;                                 // nothing was dialled (the assertions say whether that is right)
  nextTranscript = transcript;
  await call('POST', '/webhook/recording?callId=' + encodeURIComponent(dial.callId),
    { RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE' + (++recN), RecordingDuration: '30' }, null, true);
  await tick(400);
}
async function fireJob(minute, hour) { const before = dials.length; await jobFor(minute, hour).fn(); await tick(300); return dials.slice(before); }
async function firePoller() { const before = dials.length; await minuteCron().fn(); await tick(400); return dials.slice(before); }
const resolvedRow = (uid) => tables.call_history.push({ id: 'h' + (seq++), user_id: uid, county: 'montgomery', result: 'NO_TEST', pin_used: '123402', created_at: iso() });

setTimeout(async () => {
  const out = {};
  try {
    // ===== Day 1, 6:00 CDT ================================================
    // BUG 3. B3 fixed a typo after its retry was queued: the queued copy has
    // the old PIN and old email. FB moved to Fort Bend after its Montgomery
    // retry was queued.
    sched(U.B3).pin = '123403';
    tables.pending_retries.push({ id: 'prB3', user_id: U.B3, county: 'montgomery', target_number: MG, pin: '999903', notify_number: null,
      notify_email: 'old03@example.invalid', notify_method: 'email', attempt_number: 1, last_result: 'UNKNOWN', next_attempt_at: '2026-10-28T10:55:00Z', created_at: '2026-10-28T10:50:00Z' });
    tables.pending_retries.push({ id: 'prFB', user_id: U.FB, county: 'montgomery', target_number: MG, pin: '123404', notify_number: null,
      notify_email: '04@example.invalid', notify_method: 'email', attempt_number: 1, last_result: 'UNKNOWN', next_attempt_at: '2026-10-28T10:55:00Z', created_at: '2026-10-28T10:50:00Z' });
    let d = await firePoller();
    out.bug3 = { dialledWho: d.map((x) => x.to === MG ? 'montgomery' : x.to), dials: d.length };
    out.bug3.pinEntered = d[0] ? await pinDialled(d[0].callId) : null;
    out.bug3.fortBendRetryLeft = !!pending(U.FB);
    if (d[0]) await hear(d[0], ACCEPTED_NO);
    out.bug3.result = rowsFor(U.B3);
    out.bug3.pinRecorded = (tables.call_history.find((r) => r.user_id === U.B3) || {}).pin_used;
    out.bug3.mailToNew = mailTo(U.B3).length;
    out.bug3.mailToOld = emails.filter((e) => e.to === 'old03@example.invalid').length;

    // BUG 2, first morning for W1 (B3's result above is "another account got
    // through today").
    d = await fireJob(0);
    out.w1a = { dials: d.length, pin: d[0] ? await pinDialled(d[0].callId) : null };
    await hear(d[0], REJECTED);
    out.w1a.afterFirst = { rows: rowsFor(U.W1), pending: pending(U.W1) && pending(U.W1).last_result, pendingPin: pending(U.W1) && pending(U.W1).pin, mail: mailTo(U.W1).length, hearings: tables.pin_reprompts.length };
    at('2026-10-28T11:06:00Z');
    d = await firePoller();
    out.w1a.retryDials = d.length;
    out.w1a.retryPin = d[0] ? await pinDialled(d[0].callId) : null;
    await hear(d[0], REJECTED);
    const w1row = tables.call_history.find((r) => r.user_id === U.W1);
    out.w1a.afterSecond = { rows: rowsFor(U.W1), billed: !!(w1row && w1row.billed_at), charges: charges(U.W1), pendingLeft: !!pending(U.W1),
      count: sched(U.W1).consecutive_wrong_pin, enabled: sched(U.W1).enabled, mail: mailTo(U.W1) };
    const today = await call('GET', '/api/v1/today', null, 'tok-w1');
    out.w1a.today = { status: today.status, result: today.j && today.j.result, billed: today.j && today.j.billed };

    // Call Now on a rejected PIN: answered once, never counted.
    at('2026-10-28T11:20:00Z');
    const cn = await call('POST', '/api/call', { county: 'montgomery', pin: '123409', notifyEmail: '09@example.invalid', notifyMethod: 'email' }, 'tok-n1');
    d = dials.slice(-1);
    out.callNow = { status: cn.status };
    await hear(d[0], REJECTED);
    out.callNow.rows = rowsFor(U.N1);
    out.callNow.mail = mailTo(U.N1);
    out.callNow.count = sched(U.N1).consecutive_wrong_pin;
    out.callNow.enabled = sched(U.N1).enabled;

    // ===== Day 2, 6:00 CDT — W1's second WRONG_PIN morning: the pause =====
    at('2026-10-29T11:00:00Z');
    resolvedRow(U.OK);
    const w1Job = jobFor(0);
    d = await fireJob(0);
    await hear(d[0], REJECTED);
    at('2026-10-29T11:06:00Z');
    d = await firePoller();
    await hear(d[0], REJECTED);
    out.w1b = { rows: rowsFor(U.W1), enabled: sched(U.W1).enabled, reason: sched(U.W1).paused_reason, count: sched(U.W1).consecutive_wrong_pin,
      jobStopped: w1Job.stopped, pendingLeft: !!pending(U.W1), mail: mailTo(U.W1), adminSms: smsSent.filter((s) => s.to === '+15555550111' && /rejected their PIN/.test(s.body)).length };
    const resume = await call('POST', '/api/v1/schedule/resume', {}, 'tok-w1');
    out.w1b.resume = { status: resume.status, code: resume.j && resume.j.error && resume.j.error.code };
    const body = (pin) => ({ county: 'montgomery', pin: pin, callTime: '06:00', timezone: 'America/Chicago', notifyMethods: ['email'], notifyEmail: '01@example.invalid', quietMode: false });
    const same = await call('PUT', '/api/v1/schedule', body('111101'), 'tok-w1');
    out.w1b.samePinSave = { status: same.status, enabled: sched(U.W1).enabled, reason: sched(U.W1).paused_reason };
    const fixed = await call('PUT', '/api/v1/schedule', body('222201'), 'tok-w1');
    out.w1b.newPinSave = { status: fixed.status, enabled: sched(U.W1).enabled, reason: sched(U.W1).paused_reason, count: sched(U.W1).consecutive_wrong_pin };

    // ===== Day 3, 6:15 CDT — the line is unproven until someone else gets through
    at('2026-10-30T11:15:00Z');
    d = await fireJob(15);
    await hear(d[0], REJECTED);
    at('2026-10-30T11:21:00Z');
    d = await firePoller();
    await hear(d[0], REJECTED);
    out.w5 = { afterTwoAlone: { rows: rowsFor(U.W5), pending: pending(U.W5) && pending(U.W5).last_result, mail: mailTo(U.W5).length } };
    resolvedRow(U.OK);                              // someone else gets through
    at('2026-10-30T12:22:00Z');
    d = await firePoller();
    out.w5.thirdDials = d.length;
    await hear(d[0], REJECTED);
    out.w5.afterProof = { rows: rowsFor(U.W5), pendingLeft: !!pending(U.W5), count: sched(U.W5).consecutive_wrong_pin, mail: mailTo(U.W5).length };

    // ===== Day 4, 6:30 CDT — three accounts hear it: our problem =========
    at('2026-10-31T11:30:00Z');
    resolvedRow(U.OK);
    const faultAlerts = () => smsSent.filter((s) => s.to === '+15555550111' && /ask for the ID number again/.test(s.body)).length;
    d = await fireJob(30); await hear(d[0], REJECTED);
    at('2026-10-31T11:31:00Z'); d = await fireJob(31); await hear(d[0], REJECTED);
    at('2026-10-31T11:32:00Z'); d = await fireJob(32); await hear(d[0], REJECTED);
    out.fault = { afterFirstHearings: [U.W2, U.W3, U.W4].map((u) => pending(u) && pending(u).last_result), alerts: faultAlerts() };
    at('2026-10-31T11:40:00Z');
    d = await firePoller();
    out.fault.retryDials = d.length;
    for (const x of d) await hear(x, REJECTED);
    out.fault.afterRetries = [U.W2, U.W3, U.W4].map((u) => ({ rows: rowsFor(u), pending: pending(u) && pending(u).last_result, count: sched(u).consecutive_wrong_pin, mail: mailTo(u).length }));
    out.fault.alerts = faultAlerts();
    out.fault.wrongPinRowsToday = tables.call_history.filter((r) => r.result === 'WRONG_PIN' && r.created_at >= '2026-10-31T05:00:00Z').length;

    // ===== Day 4, 2:30 PM CDT — a morning that ends unconfirmed is UNKNOWN =
    tables.pending_retries.push({ id: 'prW6', user_id: U.W6, county: 'montgomery', target_number: MG, pin: '123410', notify_number: null,
      notify_email: '10@example.invalid', notify_method: 'email', attempt_number: 3, last_result: 'WRONG_PIN', next_attempt_at: '2026-10-31T19:00:00Z', created_at: '2026-10-31T11:40:00Z' });
    at('2026-10-31T19:30:00Z');
    d = await firePoller();
    out.cutoff = { dials: d.length, w6: rowsFor(U.W6), pendingLeft: !!pending(U.W6) };

    out.fault.claimRecorded = tables.admin_alert_days.filter((r) => r.alert === 'wrong_pin_fault' && String(r.day) === '2026-10-31').length;

    // ===== Day 5 (CST from Nov 1: 6:00 = 12:00Z) — ONLY the demo account
    // and one of ours have a result: the 6:07 caller must not be judged ====
    at('2026-11-02T11:05:00Z');
    const demoDialled = (await fireJob(5, 5)).length; // the demo morning (lib/demo.js): a row, no dial
    const demoRow = tables.call_history.filter((r) => r.user_id === U.DEMO).map((r) => r.result);
    tables.call_history.push({ id: 'hA5', user_id: U.ADMIN, county: 'montgomery', result: 'NO_TEST', pin_used: '123411', created_at: '2026-11-02T11:50:00Z' });
    at('2026-11-02T12:07:00Z');
    d = await fireJob(7); await hear(d[0], REJECTED);
    at('2026-11-02T12:13:00Z');
    d = await firePoller(); await hear(d[0], REJECTED);
    out.demoOnly = { demoRow, demoDialled,
      afterTwo: { rows: rowsFor(U.W7), pending: pending(U.W7) && pending(U.W7).last_result, mail: mailTo(U.W7).length } };
    resolvedRow(U.OK);                              // a subscriber gets through
    at('2026-11-02T13:14:00Z');
    d = await firePoller(); await hear(d[0], REJECTED);
    out.demoOnly.afterSubscriber = { rows: rowsFor(U.W7), count: sched(U.W7).consecutive_wrong_pin };

    // ===== Day 6 — W8's previous WRONG_PIN was three weeks ago ===========
    const w8Morning = async (day) => {
      at(day + 'T12:00:00Z'); resolvedRow(U.OK);
      at(day + 'T12:08:00Z'); let x = await fireJob(8); await hear(x[0], REJECTED);
      at(day + 'T12:14:00Z'); x = await firePoller(); await hear(x[0], REJECTED);
    };
    await w8Morning('2026-11-03');
    out.consecutive = { threeWeeksApart: { count: sched(U.W8).consecutive_wrong_pin, day: sched(U.W8).last_wrong_pin_day, enabled: sched(U.W8).enabled } };
    await w8Morning('2026-11-04');
    out.consecutive.nextDay = { count: sched(U.W8).consecutive_wrong_pin, enabled: sched(U.W8).enabled, reason: sched(U.W8).paused_reason };

    // ===== The ways round a PIN pause, for wrong_pin (W8) and pin_expired (PE)
    const bypass = async (tok, uid, pin) => {
      const r = {};
      const pz = await call('POST', '/api/v1/schedule/pause', {}, tok);
      r.pause = { status: pz.status, pauseReason: pz.j && pz.j.pauseReason, stored: sched(uid).paused_reason };
      const rs = await call('POST', '/api/v1/schedule/resume', {}, tok);
      r.resume = { status: rs.status, code: rs.j && rs.j.error && rs.j.error.code, enabled: sched(uid).enabled };
      const body = (p) => ({ county: 'montgomery', pin: p, callTime: '06:00', timezone: 'America/Chicago', notifyMethods: ['email'], notifyEmail: uid.slice(-2) + '@example.invalid', quietMode: false });
      const del1 = await call('DELETE', '/api/schedule', null, tok);
      r.deleted = { status: del1.status, gone: !sched(uid) };
      const same = await call('PUT', '/api/v1/schedule', body(pin), tok);
      r.resaveSame = { status: same.status, enabled: sched(uid) && sched(uid).enabled, reason: sched(uid) && sched(uid).paused_reason,
        counts: sched(uid) && [sched(uid).consecutive_pin_expired, sched(uid).consecutive_wrong_pin] };
      await call('DELETE', '/api/schedule', null, tok);
      const fresh = await call('PUT', '/api/v1/schedule', body('654321'), tok);
      r.resaveNew = { status: fresh.status, enabled: sched(uid) && sched(uid).enabled, reason: sched(uid) && sched(uid).paused_reason };
      r.openPauses = tables.schedule_pause_events.filter((e) => e.user_id === uid && !e.resumed_at).length;
      return r;
    };
    at('2026-11-04T15:00:00Z');
    out.bypassWrongPin = await bypass('tok-w8', U.W8, '123414');
    out.bypassPinExpired = await bypass('tok-pe', U.PE, '123415');

    // ===== Day 8 — the fault alert was already sent today by a process that
    // has since restarted: the claim in the database holds ===============
    at('2026-11-05T12:00:00Z'); resolvedRow(U.OK);
    tables.admin_alert_days.push({ alert: 'wrong_pin_fault', day: '2026-11-05', sent_at: '2026-11-05T11:50:00Z' });
    const alertsBefore = smsSent.filter((x) => x.to === '+15555550111' && /ask for the ID number again/.test(x.body)).length;
    at('2026-11-05T12:30:00Z'); d = await fireJob(30); await hear(d[0], REJECTED);
    at('2026-11-05T12:31:00Z'); d = await fireJob(31); await hear(d[0], REJECTED);
    at('2026-11-05T12:32:00Z'); d = await fireJob(32); await hear(d[0], REJECTED);
    out.alertAfterRestart = { faultSeen: pending(U.W4) && pending(U.W4).last_result,
      newAlerts: smsSent.filter((x) => x.to === '+15555550111' && /ask for the ID number again/.test(x.body)).length - alertsBefore };

    // ===== Days 8–9 — the expired-PIN count is consecutive too ==========
    at('2026-11-05T12:16:00Z'); d = await fireJob(16); await hear(d[0], EXPIRED); await tick(300);
    out.pinExpired = { threeWeeksApart: { rows: rowsFor(U.PX), count: sched(U.PX).consecutive_pin_expired, day: sched(U.PX).last_pin_expired_day, enabled: sched(U.PX).enabled } };
    at('2026-11-06T12:16:00Z'); d = await fireJob(16); await hear(d[0], EXPIRED); await tick(300);
    out.pinExpired.nextDay = { count: sched(U.PX).consecutive_pin_expired, enabled: sched(U.PX).enabled, reason: sched(U.PX).paused_reason };

    // ===== A PIN pause and a move to Fort Bend, and back ==================
    at('2026-11-06T15:00:00Z');
    const mg = (pin) => ({ county: 'montgomery', pin: pin, callTime: '06:00', timezone: 'America/Chicago', notifyMethods: ['email'], notifyEmail: '17@example.invalid', quietMode: false });
    const fb = { county: 'ftbend', ftbendOffice: 'missouri', callTime: '05:30', timezone: 'America/Chicago', notifyMethods: ['email'], notifyEmail: '17@example.invalid', quietMode: false };
    const toFb = await call('PUT', '/api/v1/schedule', fb, 'tok-fs');
    out.fortBend = { toFortBend: { status: toFb.status, err: toFb.j && toFb.j.error && toFb.j.error.code, county: sched(U.FS).county, enabled: sched(U.FS).enabled, reason: sched(U.FS).paused_reason,
      counts: [sched(U.FS).consecutive_pin_expired, sched(U.FS).consecutive_wrong_pin] } };
    const backSame = await call('PUT', '/api/v1/schedule', mg('123417'), 'tok-fs');
    out.fortBend.backSamePin = { status: backSame.status, enabled: sched(U.FS).enabled, reason: sched(U.FS).paused_reason };
    await call('PUT', '/api/v1/schedule', fb, 'tok-fs');
    const backNew = await call('PUT', '/api/v1/schedule', mg('654317'), 'tok-fs');
    out.fortBend.backNewPin = { status: backNew.status, enabled: sched(U.FS).enabled, reason: sched(U.FS).paused_reason };

    out.hearingsRecorded = tables.pin_reprompts.length;
    out.attemptOutcomes = Array.from(new Set(tables.call_attempts.map((a) => a.outcome))).sort();
  } catch (e) {
    out.error = e.stack;
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}, 1200);
