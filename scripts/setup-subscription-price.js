// One-off helper to create the recurring $14.99/mo Stripe Price.
// Run locally ONCE: node scripts/setup-subscription-price.js
// It uses STRIPE_SECRET_KEY from .env — so make sure your .env is pointed at
// the Stripe mode (live vs test) you actually want to create the Price in.
//
// Output: prints the new price ID. Set it in Railway as
// STRIPE_SUBSCRIPTION_PRICE_ID and redeploy.
//
// Safe to re-run: it will look for an existing product named "ProbationCall
// Monthly" and reuse it. Prices are immutable in Stripe, so a re-run creates
// a NEW price — only do that if you want a fresh price ID.

require('dotenv').config();
const Stripe = require('stripe');

const SECRET = process.env.STRIPE_SECRET_KEY;
if (!SECRET) {
  console.error('STRIPE_SECRET_KEY missing from environment. Aborting.');
  process.exit(1);
}
const stripe = Stripe(SECRET);
const MODE = SECRET.startsWith('sk_live') ? 'LIVE' : 'TEST';

(async () => {
  console.log(`\nUsing Stripe in ${MODE} mode.`);
  if (MODE === 'LIVE') {
    console.log('⚠️  This will create a LIVE Stripe Price. Press Ctrl-C in the next 5s to abort.');
    await new Promise((r) => setTimeout(r, 5000));
  }

  try {
    let product;
    const found = await stripe.products.search({
      query: "name:'ProbationCall Monthly' AND active:'true'",
      limit: 1
    });
    if (found.data.length > 0) {
      product = found.data[0];
      console.log('Found existing product:', product.id);
    } else {
      product = await stripe.products.create({
        name: 'ProbationCall Monthly',
        description: '30 automated probation hotline check-ins each month. Cancel anytime.'
      });
      console.log('Created product:', product.id);
    }

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 1499,
      currency: 'usd',
      recurring: { interval: 'month' },
      nickname: 'ProbationCall Monthly $14.99'
    });

    console.log('\n✅ Created Price:', price.id);
    console.log('\nNext steps:');
    console.log('  1. Set this in Railway:');
    console.log('       STRIPE_SUBSCRIPTION_PRICE_ID=' + price.id);
    console.log('  2. In Stripe Dashboard → Developers → Webhooks, add these events to your endpoint:');
    console.log('       invoice.paid');
    console.log('       invoice.payment_failed');
    console.log('       customer.subscription.deleted');
    console.log('       customer.subscription.updated');
    console.log('     (checkout.session.completed should already be enabled.)');
    console.log('  3. In Stripe Dashboard → Settings → Billing → Customer Portal, click Activate.');
    console.log('     Allow: cancel subscription, update payment method, view invoices.');
    console.log('  4. Redeploy.');
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
