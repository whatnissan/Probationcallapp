#!/usr/bin/env node
//
// One-time backfill for migration 056: profiles.subscription_current_period_end.
//
//   railway run node scripts/backfill-subscription-period-end.js          # dry run
//   railway run node scripts/backfill-subscription-period-end.js --write  # write
//
// For every profile with a stripe_subscription_id, retrieve the subscription
// from Stripe and write current_period_end. Prints before and after for each
// row. Run AFTER 056 and BEFORE the contract mirror, so the app never sees a
// null currentPeriodEnd on a live subscription. Idempotent; safe to re-run.
// Writes ONLY the period end — status and cancel fields stay as the webhooks
// left them, so this cannot silently flip anyone's status.

var { createClient } = require('@supabase/supabase-js');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY || !process.env.STRIPE_SECRET_KEY) {
  console.error('Supabase / Stripe env missing — run via `railway run`');
  process.exit(1);
}
var sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
var stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
var WRITE = process.argv.indexOf('--write') >= 0;
var ct = function(iso) { return iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'short', timeStyle: 'short' }) : 'null'; };

(async function() {
  var rows = await sb.from('profiles')
    .select('id, email, stripe_subscription_id, subscription_status, subscription_cancel_at_period_end, subscription_current_period_end')
    .not('stripe_subscription_id', 'is', null)
    .order('created_at');
  if (rows.error) { console.error('profiles read failed:', rows.error.message); process.exit(1); }
  console.log((WRITE ? 'WRITE' : 'DRY RUN') + ' — ' + rows.data.length + ' profile(s) with a subscription id\n');
  console.log('user      db_status   cancel  stripe_status  before (CT)          after (CT)');
  var written = 0, failed = 0;
  for (var i = 0; i < rows.data.length; i++) {
    var p = rows.data[i];
    var line = p.id.slice(0, 8) + '  ' + String(p.subscription_status).padEnd(11) + ' ' + String(!!p.subscription_cancel_at_period_end).padEnd(7) + ' ';
    var sub;
    try { sub = await stripe.subscriptions.retrieve(p.stripe_subscription_id); }
    catch (e) { console.log(line + 'STRIPE ERROR   ' + ct(p.subscription_current_period_end).padEnd(20) + ' (unchanged) ' + String(e.message).slice(0, 60)); failed++; continue; }
    var after = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
    line += String(sub.status).padEnd(14) + ' ' + ct(p.subscription_current_period_end).padEnd(20) + ' ' + ct(after);
    if (WRITE && after) {
      var u = await sb.from('profiles').update({ subscription_current_period_end: after }).eq('id', p.id);
      if (u.error) { line += '  WRITE FAILED: ' + u.error.message; failed++; } else { written++; }
    }
    console.log(line);
  }
  console.log('\n' + (WRITE ? written + ' written, ' : 'nothing written (dry run), ') + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function(e) { console.error(e.message); process.exit(1); });
