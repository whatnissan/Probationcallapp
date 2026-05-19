# ProbationCall — Repository Audit

Read-only review. No code was changed.

Scope reviewed: `server.js` (2734 lines), `public/*.html`, `package.json`,
`railway.json`, `Procfile`, `.env*`, `.gitignore`, and recent git history.

---

## Executive summary

Three production issues are real and serious. Ranked by severity:

1. **CRITICAL — Fort Bend color detection can return a wrong color instead of UNKNOWN.**
   `chrome` is missing from the known-colors list, and the misrecognition-fix
   table uses substring matching, so any transcript containing the substring
   `pan` (e.g. `Spanish`, `expand`, `panel`, `Pan‑American`) gets coerced to
   `Tan`. This is what produced the "chrome → Tan" result on 2026-05-16.
2. **HIGH — The Stripe webhook is likely never being triggered, and even if
   it were, it has no idempotency, no error handling, and always returns 200.**
   Several configuration/code failure modes are listed below; the fact that
   you have been manually crediting every user is consistent with the
   webhook simply not being reached.
3. **MEDIUM — The "calls haven't gone out" admin alert is structurally
   broken.** It counts every enabled schedule (including users scheduled
   for later in the day, users with zero credits who are intentionally
   skipped, and Fort Bend users who don't generate matching `call_history`
   rows) against a `MUST_TEST` / `NO_TEST` filter. False positives are
   essentially guaranteed during the morning window.

Plus several smaller items in the prioritized list at the bottom.

---

## 1. Payment / webhook flow — UNVERIFIED, multiple fault modes

### What the code does

**Checkout creation** (`server.js:900`):
- `POST /api/checkout` builds a one-time Stripe Checkout Session.
- Mode: `payment` (one-time, not subscription).
- Metadata set: `user_id`, `package_id`, `credits`, `affiliate_code`,
  `affiliate_id`.
- Packages are defined inline (`server.js:223`):
  `starter $14.99 / 30cr`, `standard $39.99 / 90cr`, `value $69.99 / 180cr`.
- A custom-credits endpoint also exists (`server.js:2619`,
  `POST /api/checkout/custom`) with the same metadata pattern.

**Webhook handler** (`server.js:948`):
- Path: `POST /webhook/stripe`.
- Raw body parser is correctly registered before `express.json()`
  (`server.js:59`), so signature verification can work.
- Verifies signature with `STRIPE_WEBHOOK_SECRET`.
- Listens for **`checkout.session.completed` only**. Nothing else.
- On that event: reads `s.metadata.user_id` and `s.metadata.credits`,
  reads current credit balance from `profiles`, writes
  `credits = current + parseInt(metadata.credits)`, inserts a
  `purchases` row, then runs the affiliate-commission block.
- Always returns `res.json({ received: true })` at the end.

### Reasons a paid checkout could fail to credit a user

These are ordered by how likely I think each is, given that you've been
manually crediting every customer.

1. **Webhook endpoint not configured in Stripe Dashboard, or pointed at
   the wrong URL.** If Stripe has no endpoint for
   `https://www.probationcall.com/webhook/stripe` (or the live-mode
   endpoint was never created, or points to a stale Railway preview URL),
   the handler is never invoked. This alone is consistent with "no real
   payment has ever auto-credited."
2. **`checkout.session.completed` not enabled** on the endpoint. If
   the endpoint exists but only listens for, e.g., `payment_intent.*`
   events, this handler never fires.
3. **Signing secret mismatch.** If Railway's `STRIPE_WEBHOOK_SECRET`
   doesn't match the secret shown for the live-mode endpoint in Stripe,
   `stripe.webhooks.constructEvent` throws and the handler returns 400.
   This would be visible in Stripe Dashboard → Developers → Webhooks →
   Recent attempts as failures.
4. **Test-mode vs. live-mode confusion.** If `STRIPE_SECRET_KEY` is a
   `sk_live_...` key but the dashboard endpoint was created in test mode
   (or vice versa), events are emitted in one mode and listened for in
   another.
5. **Unhandled promise rejection in the handler.** Lines 956–1038 are
   `await`s with no `try`/`catch`. If `supabase` returns an error
   *object* (Supabase returns errors in `result.error` rather than
   throwing), the code silently ignores it — credits update may fail
   without raising. If `supabase` throws (rare), the route handler
   rejects, Express writes a 500, and Stripe retries (and the
   non-idempotent code below double-credits on retry).
6. **No idempotency.** A retried webhook delivery for the same session
   would re-add credits, re-insert a `purchases` row (with a duplicate
   `stripe_session_id` — depending on whether a unique constraint is set
   on `purchases.stripe_session_id`, this either errors or silently
   creates a dupe), and re-credit the affiliate.
7. **`profiles` row not found at the moment the webhook fires.** The
   handler reads `profile`, then writes `currentCredits + credits` where
   `currentCredits = profile ? profile.credits : 0`. If `profile` is
   missing the update still runs (`update().eq('id', user_id)`) but
   matches zero rows — credits are silently never granted. New users are
   only inserted into `profiles` on their first authenticated API call
   (`server.js:283`), so a brand-new user who paid via a direct
   payment-link without ever logging in could hit this.
8. **`s.metadata.credits` missing or non-numeric.** If anyone has ever
   triggered a checkout that didn't pass through `/api/checkout`
   (e.g. a Stripe Payment Link or a Stripe-Dashboard-created product),
   the metadata won't be there. `parseInt(undefined)` is `NaN`,
   `current + NaN` is `NaN`, and the credits column ends up `null`/`NaN`.

### What to verify, in this order

**In Stripe Dashboard → Developers → Webhooks (live mode):**
- [ ] An endpoint exists for `https://www.probationcall.com/webhook/stripe`.
- [ ] It's in **live** mode (matches your `sk_live_...` key).
- [ ] Enabled events include `checkout.session.completed`.
- [ ] The signing secret shown matches `STRIPE_WEBHOOK_SECRET` in Railway
      (rotate if uncertain).
- [ ] Open "Recent attempts" — are there any deliveries at all? What are
      the response codes? Any 400s point at signing-secret mismatch; any
      404s point at a wrong URL; no attempts at all means the endpoint
      isn't registered or isn't subscribed to the right event.

**In Supabase:**
- [ ] `select count(*) from purchases;` — if zero or if the only rows are
      yours, the webhook has never successfully run for a real customer.
- [ ] `select * from purchases order by created_at desc limit 20;` —
      compare against the customer list you've been manually crediting.
      Every successful Stripe charge should have a matching `purchases`
      row.

**In Railway logs:**
- [ ] Search for `[CHECKOUT]` and `[AFFILIATE]` strings around the times
      of real payments. The webhook only logs when the affiliate block
      runs (`server.js:1036`); the base credit-grant has no log line, so
      success leaves no trace. That alone is a problem worth fixing.

### Other webhook-flow notes

- The webhook responds 200 even when the credit update fails
  silently — Stripe sees "delivered, success" and never retries. Add
  explicit `if (result.error) { return res.status(500)... }` on every
  Supabase call inside the handler so failures show up as retryable.
- `purchases` insert at `server.js:964` uses `s.id` (session id) as
  `stripe_session_id`. Good — that's the natural idempotency key once
  you add the check.
- The affiliate commission block writes immediately and (if Connect is
  set up) calls `stripe.transfers.create` synchronously inside the
  webhook handler. A Stripe API error here would currently 500 the
  whole handler, triggering Stripe retries and re-crediting.

---

## 2. False admin "calls haven't gone out" alert

### Where it lives

`server.js:1680–1737`. Function `checkCallHealth()`, run every 30 minutes
via `setInterval` started at server boot.

### What it does

```
hour = current CST hour
if hour < 7 || hour > 10: return
scheduled = all rows in user_schedules where enabled = true
calls = all rows in call_history where created_at is today (CST)
successCalls = calls.filter(result === 'NO_TEST' || result === 'MUST_TEST')
if calls.length > 0 && successCalls.length < scheduled.length / 2:
    send admin alert
```

### Why it fires falsely at 7:20 AM

Every one of these compounds in the same direction (denominator too big,
numerator too small):

1. **The denominator (`scheduled.length`) counts users scheduled at any
   time of day**, including 8:00, 8:30, 9:00 AM — they haven't been called
   yet at 7:20, so they can't possibly be in `successCalls`.
2. **Fort Bend users are included in the denominator** (filter is only
   `enabled = true`), but Fort Bend users never run a per-user call —
   they get notified out of the daily 5:05 system call. Their
   `call_history` rows are written with `result = 'COLOR:Tan'` /
   `'P1:... P2:...'` / `'NO_CREDITS'`, none of which match the
   `MUST_TEST`/`NO_TEST` filter at `server.js:1711`. So Fort Bend users
   inflate the denominator and contribute zero to the numerator. By
   itself this guarantees the ratio is well under 0.5 whenever Fort Bend
   subscribers are a meaningful fraction of users.
3. **Users with zero credits are intentionally skipped**
   (`server.js:863–874`, `server.js:2441–2452`) — and the skip writes
   `NO_CREDITS` to `call_history`, which also doesn't match the
   `MUST_TEST`/`NO_TEST` filter. So intentionally-skipped users count as
   failures.
4. **`UNKNOWN` and `RETRY_PENDING` results don't count as success either**,
   even though the call ran and the user was notified.
5. The "calls have started today" gate (`calls.length > 0`) trips as
   soon as the first early-morning Montgomery user produces a row, which
   is well before the late-morning users have been called.

### Why "zero-credit users are also counted as failures" — answer: yes

See point 3. Because `NO_CREDITS` rows are written for skipped users but
the success filter only counts `NO_TEST`/`MUST_TEST`, every skip is
double-bad for this metric: it's a non-call that's also recorded as a
not-success.

### Proposed fix (not applied)

Build "expected by now" instead of "all enabled":

```
gracePeriodMinutes = 20 + STAGGER_MINUTES   // stagger window + buffer
nowMinutes = currentHour * 60 + currentMin
dueSchedules = scheduled.filter(s =>
    s.county !== 'ftbend' &&                                 // FB handled by 5:05 system call
    (nowMinutes - (s.hour * 60 + s.minute)) >= gracePeriodMinutes
)
dueUserIds = set of those user_ids
calls = call_history rows where user_id in dueUserIds AND created_at >= today
// Count anything that ran as "not missed", including UNKNOWN and NO_CREDITS:
ran = calls.filter(c => c.result !== 'RETRY_PENDING')
ranUserIds = unique user_ids in ran
missed = dueSchedules.filter(s => !ranUserIds.has(s.user_id))
if missed.length >= max(3, dueSchedules.length * 0.25): alert
```

Notes for whoever implements it:
- Compare on `user_id`, not row count, so multi-row retries don't skew it.
- Use a UTC-aware `created_at` filter (the current
  `today + 'T00:00:00'` / `today + 'T23:59:59'` string compare treats
  the strings as UTC and works only by accident — it's brittle).
- `NO_CREDITS` should count as "not missed" because the user was
  intentionally skipped and was notified.
- Keep the once-per-day alert latch (`adminAlertSent`).
- Consider sending a *recovery* SMS to the user, not an admin alert, for
  individual missed users — the existing recovery cron at line 2659
  already does most of this and is the better place to attach
  per-user alerting.

---

## 3. Fort Bend color detection — "chrome" stored as "Tan"

### Where it lives

`server.js:128–199` (color list + `detectColor`).

### What happened on 2026-05-16

The hotline said **chrome**. The system logged
`Misrecognition fix: pan -> tan` and stored `Tan`. Both Missouri City and
Rosenberg were affected.

### Root causes (there are three)

**Cause A — `chrome` is not in `FTBEND_COLORS`** (`server.js:128–137`).
Confirmed by inspection. The list is alphabetical-ish with no entry for
chrome. So the first-pass exact-word loop at lines 144–151 doesn't fire.

**Cause B — the misrecognition map uses substring `includes`, not word
boundaries** (`server.js:181–186`):

```js
for (var fix in fixes) {
  if (lower.includes(fix)) {
    return fixes[fix].charAt(0).toUpperCase() + fixes[fix].slice(1);
  }
}
```

The map contains `'pan': 'tan'`. `String.prototype.includes` matches
*anywhere* in the string, so any longer word containing the letters
`pan` triggers it: `Spanish`, `expand`, `panel`, `Japan`, `companion`,
`Pan-American`, even the word `pan` appearing as part of a sentence
about something unrelated to the color. The full Fort Bend
announcement is several seconds of speech — there are lots of ways for
`pan` to appear as a substring. That is precisely how a "chrome"
announcement got mapped to `Tan`.

The same flaw applies to every other entry in the `fixes` map.
`'can': 'cyan'`, `'ten': 'tan'`, `'man': 'tan'`, `'fan': 'tan'`,
`'tin': 'tan'`, `'sign': 'cyan'`, `'ton': 'tan'`, `'hand': 'tan'` —
any of these substring-matches in the transcript will silently coerce
to the wrong color.

**Cause C — the fallback path coerces unknown speech to a color rather
than returning UNKNOWN**. The "last resort" at `server.js:189–196`
takes the first word ≥ 3 letters after "is" or "color" and accepts it
as a color, with no validation against `FTBEND_COLORS`. So if the
substring-fix had failed too, this branch could still have returned,
e.g., "Chrome" (which sounds safer but actually leaks an unvalidated
string into the notification path and into `daily_county_status.color`).

The same unvalidated behavior is in `detectPhaseColors`
(`server.js:2307`): it splits whatever comes between "today is" and
"remember" and stores the parts as `phase1` / `phase2` without
validating against any known list.

### Severity

This is the highest-severity bug in the codebase. Wrong color =
incorrect "no test today" notification to a user whose color *was*
called = missed test = real legal consequences.

### Other issues in `FTBEND_COLORS`

- Duplicates: `tan` (lines 130 and 135), `gray` (lines 131 and 136),
  `lemon` (lines 132 and 136). Harmless, just unkempt.
- The phase strings (`phase 1`, `phase 1 a`, etc.) are checked with a
  `\b` regex, which is fine in principle, but `phase 1` matches before
  `phase 1 a` does — so a transcript saying "phase 1 a" returns
  "Phase 1" because the loop returns on the first hit. Iteration order
  matters here.
- Misrecognition map has `'sign': 'cyan'` listed twice in the same
  object literal (line 177 and 178) — JS keeps the last, harmless.

### Suggested direction for the fix (not applied)

- Add `chrome` to `FTBEND_COLORS`. Also worth thinking about: `khaki`,
  `mint`, `mustard`, `slate`, `tangerine`, `mauve`. Whatever the Fort
  Bend hotline can actually announce.
- Replace `.includes(fix)` with `\b<fix>\b` regex matching in the
  misrecognition map.
- If neither known-colors nor patterns nor the (fixed) misrecognition
  map produces a hit, return `null` and let the caller record
  `UNKNOWN`. Remove the "last-resort word after is/color" branch
  entirely — wrong is much worse than unknown here.
- Validate `detectPhaseColors` output against the known-color list
  before storing; mark unvalidated phases as UNKNOWN.
- De-dupe `FTBEND_COLORS` and sort longest-first so `phase 1 a` matches
  before `phase 1`.

---

## 4. Transcription pipeline

### Path

Twilio outbound call (`server.js:1088`) →
TwiML at `/twiml/answer` plays DTMF for PIN (`server.js:1131`) →
call records (`record: true`) →
`recordingStatusCallback` hits `/webhook/recording` (`server.js:1236`) →
audio is fetched from Twilio with Basic auth (`server.js:1273`) →
sent to Deepgram `nova-2` (`server.js:1280`) →
`detectColor` / Montgomery keyword match →
SMS/email via `notify()`.

### Disabled `<Gather>` code

Twilio `<Gather>` is **not currently active anywhere in the call flow**.
`/twiml/result` (`server.js:1146`) and `/twiml/fallback`
(`server.js:1208`) still exist and reference `req.body.SpeechResult` —
these would have been wired up as the `action` / `actionOnEmptyResult`
URLs on a `<Gather>` verb, but the active `/twiml/answer` handler
doesn't emit a `<Gather>` anymore (only DTMF play + pauses + hangup).
The Fort Bend equivalent (`/twiml/ftbend-result`, `server.js:2247`,
and `/twiml/ftbend-fallback`, `server.js:2286`) is in the same state.

So those four endpoints are reachable in code but unreachable from
Twilio in normal operation. They're harmless to leave for now but
they're dead branches.

### Repeated UNKNOWN handling — there isn't any

Confirmed concern. If a user's PIN is expired (Montgomery says
"that ID number has expired") or the hotline plays back any
unexpected message, the keyword matcher returns `UNKNOWN`, a row is
inserted with `result: 'UNKNOWN'`, the user gets a "Could not
determine result" SMS, and the system goes again the next day.
**There is no detection of "this user has gotten N UNKNOWNs in a
row"** and no flagging. They will be charged daily forever.

### A credit IS charged on UNKNOWN — confirmed

`server.js:877–881` (scheduled job): credit is decremented immediately
after `initiateCall` returns, which is *before* Twilio has actually
placed the call, let alone before Deepgram has transcribed it. The
deduction is unconditional on result. Same pattern in `/api/call`
manual triggers at `server.js:1063`.

So an expired-PIN user pays one credit per day and gets nothing
actionable back.

### Other transcription notes

- Empty-transcript retry (`server.js:1296–1308`) re-calls
  `initiateCall` but then tries to find the new pending call by grabbing
  `Array.from(pendingCalls.keys()).pop()`. With concurrent calls in
  flight, that's racy and may set `transcribeRetry` on the wrong
  pending call — leading to an infinite retry loop or no retry at all
  depending on order.
- The retry also doesn't refund the credit for the failed call, even
  though the same user is being charged a second time when retry runs.
- The Fort Bend transcription branch at `server.js:1333` calls
  `detectColor(lower)` and `detectPhaseColors(transcript)`. `lower` is
  already lowercased, then `detectPhaseColors` re-lowercases internally
  — fine. But `detectColor` returns the first known color it finds in
  the announcement — for Rosenberg 2, which announces both a color and
  phase groups, this means the announcement's first matching color is
  the one stored as the office's color, regardless of phase context.
- Recording deletion (`server.js:1412`) prunes recordings older than 30
  days from Twilio — fine. But after deletion it nulls
  `recording_url` in `call_history` unconditionally for any row with
  `created_at < cutoff`, even rows where the Twilio delete failed —
  so the DB and Twilio can drift.

---

## 5. Reliability

### Recovery cron — good

`server.js:2659` (`45 * * * *`, every hour at :45). For each enabled,
non-Fort-Bend schedule:

- Skips if `minutesSinceScheduled < 20` (grace window).
- Skips if any `call_history` row exists for this user today.
- If user has no credits, notifies them and writes `NO_CREDITS`.
- Otherwise re-runs the call.

This is a sensible design and is the model the
`checkCallHealth` admin alert should follow.

### Empty-transcript admin alert — good, mostly

`server.js:1310–1326` notifies the user and pings admins via SMS when
Deepgram returns empty after retries. Healthy mechanism.

### Concerns

- **Single-process scheduling.** All `node-cron` schedules and the
  in-memory `scheduledJobs` Map live in one Node process. If Railway
  restarts during the morning window, `loadAllSchedules` reloads from
  Supabase on boot, but any individual user whose `cron.schedule` fire
  time fell inside the restart window is missed — the hourly recovery
  job catches them at :45 of the same hour at earliest.
- **WebSocket `/ws` has no auth.** `wss.on('connection', ...)` at
  `server.js:1636` accepts any client connecting to `/ws` and starts
  broadcasting `log`, `result`, and `status` events to them. The
  user_id substring is truncated to 8 chars in logs, but transcripts
  and target numbers and PINs are at risk of leaking through
  result/log broadcasts. Add auth on connection (e.g. a token query
  param verified through Supabase) or stop broadcasting sensitive
  fields.
- **`pendingCalls` is in-memory** — process restart loses all in-flight
  call state. Twilio's recording webhook would arrive and find
  `pendingCalls.get(callId) === undefined`, so the transcription is
  skipped silently.
- **No alert when the recovery cron itself fails** — the recovery loop
  is wrapped in a top-level callback with no outer try/catch. A Supabase
  outage during the recovery window would silently disable recovery.

---

## 6. Security

### Repo hygiene

- `.gitignore` correctly excludes `.env`, `.env.local`, `.env.*.local`,
  `node_modules/`, `.DS_Store`. Good.
- `git log` and `git ls-files | xargs grep` find **no committed secrets**
  in tracked files. Searched for `sk_live`, `sk_test`, `whsec_`,
  `xkeysib`, and the BREVO/DEEPGRAM/STRIPE/SUPABASE env-var names. Clean.
- `.env.example` contains only placeholders. Good.

### Local `.env` (not committed, but present on disk)

`/Users/dave/Desktop/probation-call-app/.env` contains a **real Brevo
SMTP API key** (`xkeysib-...`). It's not in git history, but:

- It's on a development machine with `.DS_Store` files visible — make
  sure no Time Machine / cloud-backed folder is syncing this
  unencrypted to a third-party service.
- Treat the local file the same way you treat Railway env vars: rotate
  it if there's any chance it's been shared (Slack, email, AI tool
  paste, etc.).

The user-facing CLAUDE.md correctly forbids printing secret values —
keep that rule.

### Hardcoded non-secret IDs

These aren't credentials, but they belong in env vars for portability
and to avoid accidentally checking in production identifiers:

- `MESSAGING_SERVICE_SID = 'MG8adbb793f6b8c100da6770f6f0707258'`
  (`server.js:78`)
- `WHATSAPP_NUMBER = 'whatsapp:+15558965863'` (`server.js:79`)
- `FROM_EMAIL = 'alerts@probationcall.com'` (`server.js:80`)
- Hardcoded Twilio messaging-service SID logged at boot
  (`server.js:1746`).

### App-layer concerns

- **Affiliate request-payout endpoint** (`server.js:617`):
  "Reset balance to 0" runs *after* the insert, with no transaction
  bracketing. If the insert succeeds and the update fails, the user has
  a pending payout request AND still has their balance. Run inside an
  RPC or accept the rare double-pay risk knowingly.
- **`/api/admin/user/:id` delete** (`server.js:2113`) issues ~10
  sequential `supabase.from(...).delete()` calls with no transaction.
  A failure mid-way leaves the user partially deleted.
- **No rate limiting** on any endpoint. `/api/checkout`,
  `/api/test-sms`, `/api/test-whatsapp` could be abused by an
  authenticated user to spam your Twilio account.
- **`auth` middleware logs the user in by reading the Bearer token**
  on every request and refetches `profiles`. That's fine; no token
  validation issues observed.

---

## 7. Prioritized issue list

### P0 — fix immediately (user-impacting, safety-critical)

1. **Fort Bend wrong-color bug** (§3). Add `chrome` (and audit other
   missing colors). Replace `.includes(fix)` with word-boundary regex.
   Remove the unvalidated "last resort" branch in `detectColor`.
   Validate `detectPhaseColors` output.

### P1 — fix before sending more traffic

2. **Stripe webhook verification** (§1). Confirm endpoint, events, and
   secret in Stripe Dashboard. Confirm at least one real `purchases`
   row exists. Then add idempotency keyed on `s.id`, proper error
   handling, and explicit logging on every credit grant.
3. **Repeated UNKNOWN and expired-PIN users keep getting charged** (§4).
   Detect N consecutive UNKNOWNs per user and email them + flag in
   admin. Either don't deduct a credit on UNKNOWN, or refund it after
   a confirmed UNKNOWN, or both.
4. **False admin call-health alert** (§2). Rebuild `checkCallHealth`
   around "scheduled time has passed by ≥ grace" per user, exclude
   Fort Bend and `NO_CREDITS`, and use unique user_ids in numerator
   and denominator. Design sketched in §2.

### P2 — reliability and correctness

5. **WebSocket `/ws` has no auth** — sensitive call data is broadcast
   to any connected client.
6. **`pendingCalls` in-memory** — Twilio recording callbacks after a
   restart are silently dropped. Persist call state or accept the
   recovery cron as the safety net.
7. **Empty-transcript retry uses `pendingCalls.keys().pop()`** — race
   condition that may mis-track retry count. Have `initiateCall`
   return the new `callId` and set the retry counter on that specific
   entry.
8. **Affiliate payout and admin-delete-user are non-transactional** —
   partial failures leave inconsistent state.
9. **Recording cleanup nulls `recording_url` even when the Twilio
   delete failed** — DB drifts from Twilio.

### P3 — hygiene

10. **`FTBEND_COLORS` has duplicates** (`tan`, `gray`, `lemon`) and the
    misrecognition map has a duplicate `'sign'` key.
11. **Hardcoded Twilio MessagingService SID, WhatsApp number, FROM
    email** — move to env vars.
12. **Repo has backup/dev files lying around** —
    `server.js.bak`, `server.js.backup`, `dashboard-backup.html`,
    `index-backup.html`, `fix_*.js`, `fix_*.sh`, `switch_to_*.js`,
    `force_port.js`, `server_fix.js`, `test-auth.html`,
    `my-portfolio-site/`. None are imported by `server.js`. Worth
    archiving out of the repo to keep the surface area honest.
13. **No rate limiting** on `/api/test-sms`, `/api/test-whatsapp`,
    `/api/checkout`.
14. **Dead `<Gather>` endpoints** (§4) — `/twiml/result`,
    `/twiml/fallback`, `/twiml/ftbend-result`, `/twiml/ftbend-fallback`.
    Either delete them or re-wire `<Gather>` as the Step-5 prompt in
    `CLAUDE.md` describes.
15. **`KEYWORDS.NO_TEST` / `KEYWORDS.MUST_TEST`** (`server.js:229`) are
    static strings. The county hotline wording occasionally changes —
    flag for periodic review.

---

## Appendix — files inspected

- `server.js` (read 1–2734)
- `public/index.html`, `public/dashboard.html` (checkout flow + pricing)
- `package.json`, `railway.json`, `Procfile`
- `.env`, `.env.example`, `.gitignore`
- `git log` (last 50 commits) and history search for committed secrets

## Appendix — files NOT inspected in depth

- `public/admin.html` (read line count only; admin UI not in scope of
  the three known issues)
- `public/dashboard-backup.html`, `public/index-backup.html` (backups)
- `server.js.bak`, `server.js.backup` (backups)
- `fix_*.js`, `switch_to_*.js`, `force_port.js`, `server_fix.js` (one-off
  scripts, not required by `package.json` start command)
- `my-portfolio-site/` (unrelated subproject)

Stopping here. Tell me which item to fix first.
