#!/usr/bin/env node
//
// Step 5 billing verification — READ-ONLY. Runs SELECTs only; writes nothing,
// bills nothing, notifies nobody.
//
// Usage (env comes from Railway, so the service key is never on disk):
//   railway run node scripts/verify-billing.js
//   railway run node scripts/verify-billing.js 2026-08-04    # a specific day
//
// Why this exists: migration 015 was deployed in code (db35986) but never
// applied to Supabase, so every credit deduction silently no-opped for 53
// days — 242 billable results across 6 users went out free while the
// notification path looked perfectly healthy. Nothing anywhere reported it.
// This script is the check that would have caught it on day one.
//
// Checks, in order:
//   1. call_deduction ledger rows for the day (the RPC actually firing)
//   2. billed_at written on the day's billable call_history rows
//   3. per-user reconciliation: notified vs billed vs ledgered
//   4. schedules paused by the depletion logic (expected vs surprise)
//   5. users at or below the low-credit warning threshold
//
// Exit code 0 = everything reconciles. 1 = something needs a human.

const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set. Run via: railway run node scripts/verify-billing.js');
  process.exit(1);
}
const supabase = createClient(url, key);

const TZ = 'America/Chicago';
const DEV_EMAILS = ['whatnissan@gmail.com', 'whatnissan@protonmail.com'];
const LOW_CREDIT_THRESHOLD = 3; // keep in sync with sendLowCreditAlert
// Montgomery MUST_TEST/NO_TEST + Fort Bend COLOR:* / P1:*
const BILLABLE_OR = 'result.eq.MUST_TEST,result.eq.NO_TEST,result.like.COLOR:%,result.like.P1:%';

function localDay(d) { return new Date(d).toLocaleDateString('en-CA', { timeZone: TZ }); }
function localTime(d) { return new Date(d).toLocaleTimeString('en-US', { timeZone: TZ, hour12: false }); }

// Chicago-local midnight boundaries for the target day, as UTC instants.
// Computed from the offset on the day itself so CST/CDT is handled.
function dayBounds(day) {
  const noonUTC = new Date(day + 'T18:00:00Z'); // ~noon Chicago in either offset
  const asLocal = new Date(noonUTC.toLocaleString('en-US', { timeZone: TZ }));
  const asUTC = new Date(noonUTC.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = asUTC.getTime() - asLocal.getTime(); // +5h CDT, +6h CST
  const start = new Date(new Date(day + 'T00:00:00Z').getTime() + offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end, utcOffset: 'UTC-' + (offsetMs / 3600000) };
}

(async function main() {
  const day = process.argv[2] || localDay(new Date());
  const { start, end, utcOffset } = dayBounds(day);
  let problems = [];

  console.log('BILLING VERIFICATION — ' + day + ' (' + TZ + ', ' + utcOffset + ')');
  console.log('window: ' + start.toISOString() + ' .. ' + end.toISOString());

  // ---- profiles for labelling -------------------------------------------
  const profs = await supabase.from('profiles').select('id,email,credits');
  if (profs.error) throw new Error('profiles: ' + profs.error.message);
  const byId = {};
  profs.data.forEach(p => { byId[p.id] = p; });
  const isDev = id => DEV_EMAILS.includes(((byId[id] || {}).email || '').toLowerCase());
  const label = id => id.slice(0, 8) + (isDev(id) ? ' [DEV]' : '');

  // ---- 1. ledger --------------------------------------------------------
  console.log('\n=== 1. call_deduction ledger rows for ' + day + ' ===');
  const led = await supabase.from('credit_transactions')
    .select('user_id,amount,balance_after,note,created_at')
    .eq('source', 'call_deduction')
    .gte('created_at', start.toISOString()).lt('created_at', end.toISOString())
    .order('created_at');
  if (led.error) throw new Error('credit_transactions: ' + led.error.message);
  console.log('rows: ' + led.data.length);
  led.data.forEach(r => console.log('  ' + localTime(r.created_at) + '  ' + label(r.user_id) +
    '  ' + r.amount + ' -> ' + r.balance_after + '  ' + (r.note || '')));

  // ---- 2. call_history --------------------------------------------------
  console.log('\n=== 2. billable call_history for ' + day + ' ===');
  const ch = await supabase.from('call_history')
    .select('user_id,result,county,billed_at,created_at')
    .gte('created_at', start.toISOString()).lt('created_at', end.toISOString())
    .or(BILLABLE_OR).order('created_at');
  if (ch.error) throw new Error('call_history: ' + ch.error.message);
  const realRows = ch.data.filter(r => !isDev(r.user_id));
  const billed = realRows.filter(r => r.billed_at);
  console.log('billable rows: ' + ch.data.length + ' (real ' + realRows.length + ', dev ' + (ch.data.length - realRows.length) + ')');
  ch.data.forEach(r => console.log('  ' + localTime(r.created_at) + '  ' + label(r.user_id) +
    '  ' + String(r.result).padEnd(12) + ' billed_at=' + (r.billed_at ? 'YES' : 'NO')));

  // ---- 3. reconciliation ------------------------------------------------
  console.log('\n=== 3. per-user reconciliation (real users) ===');
  const ledCount = {};
  led.data.filter(r => !isDev(r.user_id)).forEach(r => { ledCount[r.user_id] = (ledCount[r.user_id] || 0) + 1; });
  const rowCount = {};
  realRows.forEach(r => { rowCount[r.user_id] = (rowCount[r.user_id] || 0) + 1; });
  const billCount = {};
  billed.forEach(r => { billCount[r.user_id] = (billCount[r.user_id] || 0) + 1; });
  const users = Array.from(new Set(Object.keys(rowCount).concat(Object.keys(ledCount))));
  if (!users.length) console.log('  (no real-user billable results today)');
  users.forEach(id => {
    const results = rowCount[id] || 0, marks = billCount[id] || 0, ledger = ledCount[id] || 0;
    const ok = results === marks && marks === ledger;
    if (!ok) problems.push('user ' + id.slice(0, 8) + ': ' + results + ' results / ' + marks + ' billed_at / ' + ledger + ' ledger rows');
    console.log('  ' + (ok ? 'OK  ' : 'MISMATCH ') + label(id) +
      '  results=' + results + '  billed_at=' + marks + '  ledger=' + ledger +
      '  balance_now=' + ((byId[id] || {}).credits));
  });

  // ---- 4. paused schedules ----------------------------------------------
  console.log('\n=== 4. schedule states ===');
  const sch = await supabase.from('user_schedules').select('user_id,county,enabled,paused_reason');
  if (sch.error) throw new Error('user_schedules: ' + sch.error.message);
  const paused = (sch.data || []).filter(s => s.paused_reason === 'no_credits');
  console.log('total ' + (sch.data || []).length + ', enabled ' + (sch.data || []).filter(s => s.enabled).length +
    ', paused(no_credits) ' + paused.length);
  paused.forEach(s => {
    const bal = (byId[s.user_id] || {}).credits;
    const expected = bal !== undefined && bal < 1;
    if (!expected) problems.push('user ' + s.user_id.slice(0, 8) + ' paused for no_credits but balance is ' + bal);
    console.log('  ' + (expected ? 'expected  ' : 'SURPRISE  ') + label(s.user_id) + '  balance=' + bal);
  });

  // ---- 5. low-credit warning population ---------------------------------
  console.log('\n=== 5. users at/below the low-credit threshold (' + LOW_CREDIT_THRESHOLD + ') ===');
  const enabledIds = (sch.data || []).filter(s => s.enabled).map(s => s.user_id);
  const low = enabledIds.filter(id => !isDev(id) && ((byId[id] || {}).credits) <= LOW_CREDIT_THRESHOLD);
  if (!low.length) console.log('  none — no warning was due today');
  low.forEach(id => console.log('  ' + label(id) + '  credits=' + ((byId[id] || {}).credits) +
    '  (expect a warning after today\'s billed call)'));

  // ---- verdict ----------------------------------------------------------
  console.log('\n=== VERDICT ===');
  if (realRows.length === 0) {
    console.log('INCONCLUSIVE — no real-user billable results on ' + day + '. Nothing to verify.');
    process.exit(1);
  }
  if (problems.length === 0) {
    console.log('PASS — ' + realRows.length + ' real billable results, all with billed_at and a matching ledger row.');
    process.exit(0);
  }
  console.log('FAIL — ' + problems.length + ' problem(s):');
  problems.forEach(p => console.log('  - ' + p));
  process.exit(1);
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
