#!/usr/bin/env node
// Seed (or re-seed) the App Review demo account. Idempotent. Run with the
// production environment:
//
//   DEMO_ACCOUNT_PASSWORD='...' railway run node scripts/seed-demo-account.js
//
// Needs DEMO_ACCOUNT_EMAIL in the environment (Railway) and the password at
// run time. Creates the auth user if missing, flags the profile is_demo,
// grants 60 credits once, writes the Montgomery schedule (the demo PIN from lib/demo.js, 6:00
// AM Central, email notify to the demo address), and replaces the call
// history with 120 synthetic mornings ending yesterday. The scheduler picks
// the account up at the next server start (rescheduleUser runs at boot).
var path = require('path');
var { createClient } = require('@supabase/supabase-js');
var demo = require(path.join(__dirname, '..', 'lib', 'demo'));

var email = String(process.env.DEMO_ACCOUNT_EMAIL || '').trim().toLowerCase();
var password = process.env.DEMO_ACCOUNT_PASSWORD || '';
if (!email || !password) { console.error('DEMO_ACCOUNT_EMAIL (env) and DEMO_ACCOUNT_PASSWORD (run time) are required'); process.exit(1); }
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) { console.error('Supabase env missing — run via `railway run`'); process.exit(1); }
var sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
var MONTGOMERY_NUMBER = process.env.MONTGOMERY_HOTLINE_NUMBER || '+19362834848'; // COUNTIES.montgomery.number in server.js
var DAYS = 120;

(async function() {
  // 1. auth user
  var userId = null;
  var created = await sb.auth.admin.createUser({ email: email, password: password, email_confirm: true });
  if (created.error) {
    var page = 1, found = null;
    while (!found) {
      var list = await sb.auth.admin.listUsers({ page: page, perPage: 1000 });
      if (list.error) throw new Error('listUsers: ' + list.error.message);
      found = (list.data.users || []).find(function(u) { return String(u.email || '').toLowerCase() === email; });
      if (!found && (list.data.users || []).length < 1000) break;
      page++;
    }
    if (!found) throw new Error('createUser failed and user not found: ' + created.error.message);
    userId = found.id;
    var upd = await sb.auth.admin.updateUserById(userId, { password: password });
    if (upd.error) throw new Error('password update: ' + upd.error.message);
    console.log('auth user exists — password updated');
  } else {
    userId = created.data.user.id;
    console.log('auth user created');
  }

  // 2. profile — is_demo, and the credit grant only once
  var pr = await sb.from('profiles').select('id, credits, is_demo').eq('id', userId).maybeSingle();
  if (!pr.data) {
    var ins = await sb.from('profiles').insert({ id: userId, email: email, credits: 0, is_demo: true, referral_code: 'DEMO' + userId.slice(0, 4).toUpperCase(), affiliate_balance_cents: 0, affiliate_total_earned_cents: 0 });
    if (ins.error) throw new Error('profile insert: ' + ins.error.message);
    console.log('profile created');
  } else {
    var up = await sb.from('profiles').update({ is_demo: true, is_disabled: false }).eq('id', userId);
    if (up.error) throw new Error('profile update: ' + up.error.message);
  }
  var grant = await sb.from('credit_transactions').select('id').eq('user_id', userId).eq('source', 'demo_seed').limit(1);
  if (!(grant.data && grant.data.length)) {
    var rpc = await sb.rpc('add_credits_with_ledger', { p_user_id: userId, p_amount: 60, p_source: 'demo_seed', p_note: 'App Review demo account', p_performed_by: null, p_stripe_session_id: null, p_stripe_invoice_id: null });
    if (rpc.error) throw new Error('credit grant: ' + rpc.error.message);
    console.log('60 credits granted');
  } else {
    console.log('credits already granted — skipped');
  }

  // 3. schedule
  var sched = {
    user_id: userId, county: 'montgomery', target_number: MONTGOMERY_NUMBER, pin: demo.DEMO_PIN,
    notify_number: null, notify_email: email, notify_method: 'email',
    hour: 6, minute: 0, timezone: 'America/Chicago', quiet_mode: false, ftbend_office: 'missouri',
    enabled: true, paused_reason: null, consecutive_pin_expired: 0
  };
  var su = await sb.from('user_schedules').upsert(sched, { onConflict: 'user_id' });
  if (su.error) throw new Error('schedule upsert: ' + su.error.message);
  console.log('schedule written: Montgomery, PIN ' + demo.DEMO_PIN + ', 06:00 America/Chicago, email notify');

  // 4. history — replace wholesale so a re-seed never stacks
  var del = await sb.from('call_history').delete().eq('user_id', userId);
  if (del.error) throw new Error('history clear: ' + del.error.message);
  var rows = demo.seedDemoHistory(userId, MONTGOMERY_NUMBER, DAYS, new Date());
  for (var i = 0; i < rows.length; i += 200) {
    var chunk = await sb.from('call_history').insert(rows.slice(i, i + 200));
    if (chunk.error) throw new Error('history insert: ' + chunk.error.message);
  }
  var musts = rows.filter(function(r) { return r.result === 'MUST_TEST'; }).length;
  console.log(DAYS + ' mornings seeded (' + musts + ' required tests, ' + rows.filter(function(r) { return r.result === 'UNKNOWN'; }).length + ' unknown)');
  console.log('done — user ' + userId.slice(0, 8) + '. Restart the server (or wait for the next deploy) so the scheduler picks up the demo schedule.');
})().catch(function(e) { console.error('seed failed:', e.message); process.exit(1); });
