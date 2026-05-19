# ProbationCall — Claude Code Prompt Pack

A staged set of prompts for moving ProbationCall development to Claude Code. Work through them **in order**, one at a time. Each prompt is scoped so a single change can be reviewed and rolled back if needed.

**How to use this:**
1. First, create the `CLAUDE.md` file below in your repo root and commit it. This gives Claude Code permanent project context so you don't re-explain the stack every session.
2. Then paste the prompts one at a time. Don't paste the next one until the current change is reviewed and deployed.
3. Every prompt tells Claude Code **not to push** — you push to GitHub yourself, since that triggers a live Railway deploy.

---

## STEP 0 — Create `CLAUDE.md` in the repo root

This is the project memory file Claude Code reads at the start of every session. Save it as `CLAUDE.md` in the root of `Probationcallapp`, then commit it.

```markdown
# ProbationCall — Project Context

## What this is
ProbationCall (probationcall.com) automates daily probation drug-test hotline calls.
Each morning at 5:05 AM CST it calls county hotlines, navigates the IVR with DTMF tones,
detects the announced color/phase, and notifies subscribers by SMS + email whether they
must report for testing.

## Stack
- Runtime: Node.js / Express. Entry point: server.js
- Database + Auth: Supabase
- Voice + SMS: Twilio (outbound caller number +1 877 884 7310)
- Transcription: Deepgram (nova-2 model), post-call from the call recording
- Email: Brevo HTTP API — Railway blocks SMTP, so DO NOT use nodemailer/SMTP
- Payments: Stripe (LIVE mode)
- Hosting: Railway. Auto-deploys on git push to GitHub repo whatnissan/Probationcallapp

## Counties supported
- Montgomery County — PIN-based IVR
- Fort Bend County — three offices: Missouri City, Rosenberg, Rosenberg 2
- Rosenberg 2 announces BOTH a color (e.g. "Grey") and phase groups
  (e.g. "Phase 1 and Phase 3", "Prep")

## Golden rules — always follow
1. DO NOT git push. Make changes, write a clear commit message if you commit, but I push
   to GitHub myself — pushing triggers a live production deploy.
2. Work incrementally. One scoped change at a time. Show me the diff before I deploy.
3. Never hardcode secrets. All keys come from environment variables. Never print secret values.
4. Email templates must use table-based HTML layout — Gmail mobile renders div layouts
   inconsistently.
5. Speech recognition needs misrecognition mapping (e.g. "can" -> "cyan"). The color/phase
   arrays need ongoing maintenance — don't remove entries.
6. An empty hotline transcript is an outage signal — keep the retry logic and admin
   alerting intact.
7. Assume rollback may be needed. Avoid sweeping multi-file changes that are hard to revert.

## Environment variables (names only — values live in Railway, never commit them)
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, DEEPGRAM_API_KEY,
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, Supabase keys, Brevo API key, BASE_URL
```

---

## STEP 1 — Full site audit (read-only, no changes)

```
Audit this repository end to end. Make NO code changes — this is a read-only review.
Read server.js and the public/ HTML files, and produce a written audit report in
markdown covering:

1. PAYMENT FLOW — Trace checkout -> Stripe -> webhook -> credit granting -> affiliate
   commission. List which Stripe events the webhook handles, how credits are added to
   profiles, how the purchases row is written, and any place a payment could succeed
   without credits landing.

2. TRANSCRIPTION PIPELINE — Trace the daily call: Twilio call -> IVR / DTMF ->
   recording -> Deepgram nova-2 transcription -> color/phase keyword detection ->
   SMS + email notification. Note where the old Twilio <Gather> code is and whether
   it's still referenced anywhere.

3. RELIABILITY — Describe the retry logic and the admin health-alert system. Flag any
   gap where a failed or missed morning call would go unnoticed.

4. SECURITY — Check whether any secret keys or tokens are hardcoded in source files or
   committed to git history. Confirm .env is gitignored. List anything that should be
   moved to environment variables or rotated.

5. KNOWN ISSUE LIST — A prioritized list of bugs, risks, and cleanup items you found.

Output the report and then STOP. Do not make changes. I'll tell you which item to fix first.
```

---

## STEP 2 — Verify and fix the payment webhook

```
A real customer paid via Stripe, but I need to confirm their 30 credits were actually
granted. Investigate the webhook reliability:

1. Trace the /webhook/stripe handler. Identify every reason a completed Stripe payment
   could fail to grant credits — wrong endpoint URL, signing-secret mismatch, missing
   event type, missing or malformed metadata, an unhandled error.

2. Tell me exactly what to check in the Stripe Dashboard (webhook endpoint URL, which
   events are enabled, the signing secret) and in Railway env vars so I can confirm the
   config is correct. The endpoint should be https://www.probationcall.com/webhook/stripe.

3. Add idempotency so a Stripe webhook retry can NEVER double-credit an account (e.g.
   key off the Stripe event ID or session ID against the purchases table).

4. Add clear logging around credit granting so future payment issues are easy to trace.

If you find an actual code bug, fix it. Show me the diff. Do not push — I'll review and
deploy. I'll run the live test purchase myself.
```

---

## STEP 3 — Change the landing page to a single $14.99/month offer

```
Change the main landing page so the pricing section presents ONE offer only:
$14.99 / month, 30 credits, auto-renews monthly, cancel anytime.

Requirements:
- Remove the three-tier bundle pricing (Starter / Standard / Value) from the LANDING
  PAGE display only.
- Do NOT delete the bundle package definitions or the bundle checkout code in server.js.
  Keep them intact in the backend so this is reversible and they can stay as in-dashboard
  options. This change is landing-page presentation only.
- Update the headline and call-to-action copy to match a single, simple monthly price.
- Keep the existing "try it free" / free-starter-credits messaging if present.
- Keep the current marketing tone — direct and a bit edgy, honest about real consequences.

Show me the diff. Do not push — I'll review and deploy.
```

---

## STEP 4 — Build the $14.99/month subscription (auto-draft)

```
Add a recurring monthly subscription: $14.99/month that grants 30 credits on each
successful payment. The existing one-time credit bundles stay as-is in the backend.

Implement:
1. STRIPE PRICE — Set up a recurring monthly Price of $14.99. Either write a one-off
   Stripe API script for me to run, or give me the exact dashboard steps — recommend
   which is safer and wait for me before creating anything in live-mode Stripe.

2. SUBSCRIPTION CHECKOUT — Add a checkout flow using mode: 'subscription' for that Price,
   alongside the existing one-time bundle checkout.

3. WEBHOOK — Extend /webhook/stripe to handle recurring billing:
   - invoice.paid / invoice.payment_succeeded -> grant 30 credits (this fires every
     month on renewal, not just the first payment).
   - invoice.payment_failed -> log it and flag the account.
   - customer.subscription.deleted -> mark the subscription inactive.
   Keep the handler idempotent so a webhook retry never double-credits.

4. CANCELLATION — Add a way for subscribers to cancel cleanly (Stripe Customer Portal is
   the simplest). Probation ends, so people WILL cancel — a clean cancel path prevents
   chargebacks and complaints.

5. DASHBOARD UI — Add a "Subscribe — $14.99/mo, auto-refill 30 credits" button and a
   "Manage subscription" link.

DECISION I NEED TO MAKE — before implementing affiliate logic, ask me: should an
affiliate earn their 30% commission on EVERY monthly renewal, or only on the first
month's payment? Do not assume — surface this and wait for my answer.

Show me the diff. Do not push — I'll review and deploy.
```

---

## STEP 5 — Revive Twilio `<Gather>` as a transcription fallback

```
Twilio's February 2025 move of its multi-provider speech recognition system to general
availability broke our old <Gather> config — it now returns error 13343, "invalid config
for speech provider." Re-enable <Gather> with a valid configuration.

Requirements:
1. Set speechModel explicitly to "deepgram_nova-2" (the same engine our post-call
   transcription already uses successfully).
2. speechTimeout MUST be a positive integer, NOT "auto" — "auto" is invalid when
   speechModel is set and is a likely cause of the 13343 error.
3. Set language="en-US", input="speech" (keep DTMF input where the IVR navigation
   needs it), and add hints/keywords for the colors and phase groups we expect.

ARCHITECTURE — make <Gather> a true fallback, not a hard switch:
- <Gather> runs first. If it returns a confident result that matches a known
  color/phase, use it and tag the result source as "gather".
- If <Gather> returns empty, low confidence, or no known match, fall through to the
  existing Deepgram post-call transcription path (which works today).
- A failed or misconfigured <Gather> must NEVER throw an application error that drops
  the call — that was the original failure mode. Verify the call survives a Gather
  failure and still records.

Keep recording every call regardless. Show me the diff. Do not push — I'll review and
deploy, then test against Montgomery County and all three Fort Bend offices (including
Rosenberg 2's phase-group announcements) before making Gather the primary path.
```

---

## Recommended order and open decisions

**Order:** Step 0 (CLAUDE.md) → Step 1 (audit) → then 2, 3, 4, 5. Do Step 2 before sending
any more traffic to the site — confirming credits land is the gate.

**Decisions you'll need to answer when prompted:**
- Affiliate commission on subscriptions — every renewal, or first month only? (Step 4)
- Whether to eventually retire the one-time bundles entirely, or keep them as in-dashboard
  options. For now they stay in the code; the landing page just stops showing them.
- After Step 5 is tested clean, whether to promote `<Gather>` to primary or leave Deepgram
  post-call as primary with Gather as backup.
