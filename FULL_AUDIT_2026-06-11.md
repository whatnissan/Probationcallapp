# ProbationCall — Full Repository Audit & Improvement Plan
**Date:** 2026-06-11 · **Scope:** entire repo at commit `3738fef` · **Mode:** read-only (no code changed)

---

## 1. Executive Summary

**Overall health: C+ (trending up).** The core money and call-orchestration logic is genuinely well-engineered — idempotent credit grants, DB-backed retry state with leases and cutoffs, signature-verified Stripe webhooks, and code comments that preserve incident history. What drags the grade down is everything *around* that core: a 4,994-line single-file server with **zero tests and no CI** on a system whose wrong output has legal consequences for users, several authorization gaps at the edges, fragile in-memory state on a host that redeploys on every git push, and a repo full of tracked junk (backup files, an unrelated portfolio site nested three levels deep).

**Top 3 risks:**
1. **Unauthenticated/unverified edges** — Twilio webhooks accept forged requests (which can leak Twilio credentials to an attacker-controlled URL), the recording proxy has no auth, and the `is_disabled` flag is never enforced.
2. **In-memory state vs. deploy-on-push** — a Railway deploy during the morning call window silently orphans in-flight calls and pending Fort Bend notifications; users get nothing and (for Fort Bend) nothing retries.
3. **No safety net** — zero tests/CI means every change to detection or billing logic ships on faith; a regression of this exact kind already occurred (Commit B regression, fixed in `3738fef`).

**Top 3 opportunities:** (1) unit tests around the pure detection/pricing functions are cheap and high-value — they're already side-effect-light; (2) persisting call config to the DB at initiation removes the single biggest reliability hole for ~50 lines of change; (3) a half-day of repo hygiene (delete junk, fix README, gitignore `.env.production`) removes most of the "ugly" instantly.

---

## 2. Repo Map

**Purpose:** probationcall.com — calls county drug-test hotlines each morning (Twilio + DTMF), transcribes the announcement (Deepgram nova-2 post-call), detects color/phase/test-required, and notifies subscribers by SMS/email. Paid via Stripe (credits + $14.99/mo subscription). Production service with real paying customers; solo-maintained.

**Stack:** Node.js 20 / Express 4 (single process), Supabase (DB + auth, service key server-side, anon key in browser), Twilio (voice/SMS/WhatsApp), Deepgram (HTTP API), Brevo (email via HTTP), Stripe (live mode), Railway (auto-deploy on push to `main`, NIXPACKS, `node server.js`).

**Architecture:** one god file, `server.js` (4,994 lines), containing: Brevo client (15), color/phase detection (133–233), credit ledger + idempotent dedup (408–508), streak auto-pause logic (536–636), Montgomery retry orchestration (657–864), auth middleware (935), user/affiliate/admin REST API, the Stripe webhook (2200–2447), call initiation + TwiML + recording/status webhooks (2474–3059), notification senders (3061–3243), WebSocket auth (3245), Fort Bend multi-office system with finishprobation.com cross-check (3955–4499), checkout endpoints (4578–4677), and three cron jobs including a per-minute retry poller (4780–4991). `module.exports = app` sits mid-file at 4689 with live cron registrations after it.

| Path | What it is |
|---|---|
| `server.js` | Everything (4,994 lines) |
| `public/*.html` | Landing, login, dashboard (2,137 lines, all JS inline), admin panel, legal pages, a debug page |
| `migrations/001–011` | Additive, well-commented SQL migrations (run manually) |
| `scripts/setup-subscription-price.js` | One-off Stripe price creator |
| `CLAUDE.md`, `AUDIT.md`, `AFFILIATE_AUDIT.md` | Project context + two prior audits (partially stale) |
| `server.js.backup`, `server.js.bak`, `fix_*.{js,sh}`, `switch_to_*.js`, `force_port.js`, `server_fix.js` | **Tracked junk** — dead one-off scripts and stale copies of server.js |
| `my-portfolio-site/` (×3 nested) | **Unrelated project committed recursively into itself**, tracked in git |
| `.env.production` | Tracked in git — verified to contain only placeholder values, but shouldn't exist |

**Surprises:** the recursive `my-portfolio-site`; a dangling `// SAFETY FALLBACK` comment as the literal last line of server.js (4994) with no code under it; `formatPhone()` spliced into the middle of the affiliate constants block leaving an orphaned `} // 30% commission` (server.js:245–253); `README.md` describes an entirely different, older app (single hotline `+1 915-265-6476`, no Supabase/Stripe).

---

## 3. Audit Report

Severity legend: **C**ritical / **H**igh / **M**edium / **L**ow. Each finding marked **[fact]** (verified in code) or **[judgment]**.

### 3.1 Security

| # | Sev | Finding |
|---|---|---|
| S1 | **H** | **`is_disabled` is never enforced.** [fact] Admin can set it (`server.js:3585–3593`) and the admin UI renders it, but the `auth` middleware (`server.js:935–993`) and `adminAuth` (`3414`) never check it. The only other references are display counters (`3499`). A "disabled" user retains full API access: scheduling calls, checkout, affiliate endpoints. Consequence: the abuse kill-switch is decorative. |
| S2 | **H** | **No Twilio webhook signature validation → forged-webhook credential leak.** [fact] `/webhook/recording` (`2536`), `/webhook/status` (`2992`), and `/twiml/*` accept any POST. `/webhook/recording` takes the attacker-supplied `RecordingUrl` and fetches it **with the Twilio Basic-auth header attached** (`2573–2577`) — a forged request with `RecordingUrl=https://evil.com/x` sends your `TWILIO_ACCOUNT_SID:AUTH_TOKEN` to the attacker. The attacker must guess an active `callId`, but those are `call_<Date.now()>` (`2475`) — a millisecond timestamp, brute-forceable during the known 5:05–6:15 AM window. Twilio account takeover = outbound calls on your dime and access to all recordings. Fix: validate `X-Twilio-Signature` and/or restrict the fetch to `api.twilio.com` hosts. |
| S3 | **C (verify)** | **RLS posture of core tables is unverifiable from the repo.** [judgment + fact] The Supabase **anon key is published in every public HTML file** (`public/login.html:52`, `index.html:351`, `admin.html:54`, `dashboard.html:669`, `test-auth.html:20`) — normal for Supabase, *safe only if RLS is enabled on every table*. Migrations enable RLS only on the two tables they create (`migrations/002:31`, `migrations/011:42`); migration 011 references "the day's RLS lockdown pattern," implying a lockdown happened, but `profiles`, `user_schedules`, `call_history`, `purchases`, `affiliate_earnings` etc. were created outside these migrations and their RLS state cannot be confirmed here. If any lacks RLS, the entire customer database (emails, phone numbers, PINs, probation data) is world-readable via the published anon key. **Must be verified in the Supabase dashboard — see Open Questions.** |
| S4 | **M** | **Unauthenticated Twilio recording proxy.** [fact] `GET /api/recording/:recordingSid` (`server.js:4441–4461`) streams any recording in your Twilio account to anyone holding a SID — no auth, no ownership check. SIDs are high-entropy, but they leak (see S5), and Montgomery recordings capture the user's PIN being keyed in. |
| S5 | **M** | **`/api/ftbend/today` is unauthenticated and returns `transcript` and `recording_url`** (`server.js:4463–4496`) — recording URLs contain the `RE…` SIDs that make S4 exploitable. Hotline content is low-sensitivity, but this endpoint shouldn't hand out recording SIDs to the public internet. |
| S6 | **L** | Debug page `public/test-auth.html` deployed to production — live OAuth tester wired to your Supabase project. Remove or gate it. [fact] |
| S7 | **L** | `.env.production` tracked in git (`git ls-files`) and committed historically. Current contents are **placeholders only (verified)** and `.env` itself was never committed — but `.gitignore` doesn't cover `.env.production`, so one careless edit commits live keys. [fact] |
| S8 | **L** | Hardcoded Twilio Messaging Service SID + WhatsApp number fallbacks (`server.js:79–80`, also in `server.js.bak:37`). Identifiers, not secrets; already acknowledged in a comment. [fact] |

**Healthy:** Stripe webhook signature verification is correct, with `express.raw` mounted before the JSON parser (`server.js:59`, `2200–2207`). No real secrets found anywhere in source or in the 364-commit history (scanned for `sk_live`, `whsec_`, Twilio SIDs, JWTs).

### 3.2 Correctness & code quality

| # | Sev | Finding |
|---|---|---|
| C1 | **H** | **`/api/checkout/custom` can crash the whole server.** [fact] It's the only Stripe-calling route with no try/catch (`server.js:4641–4677`). If `stripe.checkout.sessions.create` rejects (Stripe hiccup, bad key after rotation), Express 4 doesn't catch async errors and Node 20's default is to **terminate the process on unhandled rejection** — killing every scheduled job mid-morning. Same class of risk applies to any future uncaught async route. Fix: try/catch here + a process-level `unhandledRejection` logger + an async-route wrapper. |
| C2 | **H** | **`invoice.payment_failed` handling silently no-ops on the current Stripe API.** [fact] `handleSubscriptionInvoicePaymentFailed` gates on the legacy `invoice.subscription` field (`server.js:1823`) — the exact field your own comment at `1699–1707` documents as removed in the 2025-11-17 API (and which already bit you once on `invoice.paid`). On current payloads it returns early; `subscription_status` never becomes `past_due`, so failed renewals look active. The defensive multi-path resolution built for `invoice.paid` (`1710–1717`) was never applied here. `charge.invoice` at `2098` has the same exposure (lower impact — `payment_intent` is the primary lookup). |
| C3 | **M** | **`last_login` is never written.** [fact] `supabase.from('profiles').update({last_login...})` is fired without `await`/`.then()` at `server.js:987` and `3426`. supabase-js v2 query builders are lazy — they only execute when awaited — so these two statements are no-ops. Masked because the admin UI falls back to auth's `last_sign_in_at`. |
| C4 | **M** | **Credit deduction is non-atomic read-modify-write** (`server.js:468–486`): read `credits`, compute, `update`. The *add* path got an atomic RPC (`add_credits_with_ledger`, `408`); the deduct path didn't, and deductions also skip the ledger entirely. Affiliate balance update has the same RMW pattern (`2345–2364`). Concurrency is low (one call/user/day) but money paths should not have lost-update windows. [fact + judgment] |
| C5 | **M** | **Webhook idempotency has a crash window on the one-time path.** [fact] Dedup keys off the `purchases` row (`2263–2274`), which is inserted *after* the credit grant (`2288–2308`). A crash between grant and insert → Stripe retries → double credit. The subscription path is safer only if the RPC's `stripe_invoice_id` is checked — it isn't; the same `purchases`-after-grant ordering applies (`1771–1809`). Narrow window, real money. |
| C6 | **L** | Signup race in `auth`: two concurrent first requests both see no profile, both call `recordCreditAdd` → double starter credits (`server.js:948–970`). The PK blocks the duplicate profile row but not the second grant. [fact] |
| C7 | **L** | Promo redemption race: check-then-insert with no unique constraint (`server.js:1399–1403`) can exceed `max_uses` under concurrency. [fact] |
| C8 | **L** | `_rateBuckets` map grows forever — entries are never pruned (`server.js:915–933`). Slow leak, bounded by user count in practice. [fact] |
| C9 | **L** | Edit-scar code smells: `formatPhone` spliced into the constants block with the orphaned `} // 30% commission` (`245–253`); `module.exports = app` mid-file (`4689`); dangling `// SAFETY FALLBACK` final line (`4994`). [fact] |
| C10 | **L** | The hand-rolled CST date idiom `new Date(now.toLocaleString('en-US',{timeZone:...}))` is duplicated ~6× (`2552–2554`, `3322–3324`, `3618–3620`, `4222–4224`, `4295–4297`, `4464–4466`) even though a correct helper, `formatLocalDay` (`661`), already exists and is used elsewhere. The idiom is also locale-parsing-dependent and subtly fragile. [fact] |

### 3.3 Reliability (the product's core promise)

| # | Sev | Finding |
|---|---|---|
| R1 | **H** | **All in-flight call state lives in the in-memory `pendingCalls` map** (`server.js:72`), with a 10-minute TTL (`2506–2508`) — on a host that **redeploys on every git push**. A restart during the 1–5 minutes between `calls.create` and the recording webhook orphans the call: `/webhook/recording` finds no config and returns silently (`2548`). Montgomery is backstopped by the `:45` recovery cron (`4693`). **Fort Bend attempt #1 is not**: no `fort_bend_retries` row exists yet, so the office is never retried that day and subscribers hear nothing. [fact] |
| R2 | **M** | **Fort Bend user notifications are scheduled with bare `setTimeout`, potentially hours into the future** (`server.js:4305–4311` — delayed until the user's preferred time). A deploy in that window silently drops the notification *and* the `call_history` insert that lives inside the same timer. No recovery path exists. [fact] |
| R3 | **M** | `checkCallHealth` only alerts when ≥3 users **and** ≥25% missed (`server.js:3368–3369`). With a small user base, a single user's calls can fail every day forever without an admin alert — at odds with golden rule 6's intent. The per-user streak pause (3 days, `534`) eventually notifies, but that's three missed mornings. [judgment] |
| R4 | **L** | `doCrossCheck` mutates `FTBEND_MISRECOGNITIONS` in memory at runtime (`4209–4213`) — self-noted as "in-memory only," lost on restart; learned mappings are logged but must be hand-codified. Acceptable, but it means behavior differs between a long-lived and freshly-restarted process. [fact] |

**Healthy:** the retry architecture itself is strong — DB-persisted `pending_retries`/`fort_bend_retries`, per-minute poller with leases (`4853`, `4973`), fire-time cutoff re-checks, orphan cleanup (`4806–4825`), stale-row day checks (`794–800`), and a documented regression fix for the poller early-return bug (`4782–4788`).

### 3.4 Testing — the ugliest part

| # | Sev | Finding |
|---|---|---|
| T1 | **C** | **Zero tests. No test runner, no CI, no lint.** [fact — `package.json` has only a `start` script; no workflow files exist] This system bills money and tells people under court supervision whether to report for a drug test. Detection regressions have already shipped (chrome→Tan, 2026-05-16; Commit B poller regression, 2026-05-21→29 — both documented in code comments). The most regression-prone logic is *pure and trivially testable today*: `detectColor` (173), `detectPhaseColors` (4033), `doCrossCheck` (4162), `detectPinExpired` (395), `computeTieredPriceCents` (4535), `wouldExceedCutoff`/`wouldExceedFtbendCutoff` (690/708), `formatPhone` (245). Every historical incident transcript in `fort_bend_learnings` is a free test fixture. |

### 3.5 Performance
Healthy at current scale. `/api/admin/dashboard` loads all users + `auth.admin.listUsers()` + 2,000 calls per view (`3437–3529`) — heavy but admin-only; revisit past ~1k users. One sentence is all this dimension needs.

### 3.6 Dependencies

| # | Sev | Finding |
|---|---|---|
| D1 | **M** | `npm audit`: **2 moderate** vulns via `node-cron@3.0.3 → uuid`. Fix requires `node-cron@4` (breaking — and cron is the heart of this app, so it needs the test net first). [fact] |
| D2 | **M** | `stripe@13.11.0` vs current `22.x` — nine majors behind. The codebase is compensating with defensive multi-path payload reads (`1699–1717`, `1795–1800`) instead of upgrading the SDK and pinning `apiVersion` explicitly, which would make payload shape deterministic. [fact + judgment] |
| D3 | **L** | Express 4.22 (fine — don't chase v5), supabase-js 2.86 (minor updates available), lockfile present and consistent. [fact] |

### 3.7 DevEx, operations, documentation

| # | Sev | Finding |
|---|---|---|
| O1 | **H** | **No staging: `git push` = live deploy** (railway.json, CLAUDE.md golden rule 1). Combined with T1 (no CI), the only gate between an edit and production phone calls is eyeballing a diff. [fact] |
| O2 | **M** | **README.md describes a different app** — wrong hotline number, no mention of Supabase/Stripe/Brevo/counties, Node 18. Anyone onboarding from it (including future AI sessions that read it) gets actively misled. CLAUDE.md is the real doc and is good. [fact] |
| O3 | **M** | Tracked junk: `server.js.backup`, `server.js.bak`, `server_fix.js`, `fix_hang.js`, `fix_schedule*.sh`, `fix_server_port.js`, `force_port.js`, `switch_to_api.js`, `switch_to_ssl.js`, and the triple-nested `my-portfolio-site/`. Verified to contain no secrets, but they bloat every clone, confuse search, and `server.js.bak` shows up in grep results as if it were live code. [fact] |
| O4 | **L** | `AUDIT.md` is partially stale — its top findings (chrome→Tan, webhook idempotency, health-alert logic) have since been fixed per git history, but the file doesn't say so. [fact] |
| O5 | **L** | Logging is consistent and greppable (`[TAG]` prefixes) — genuinely good — but there's no error aggregation; production visibility is Railway log tailing. [judgment] |

### 3.8 Strengths (preserve these)

- **Money-path discipline:** signature-verified webhook, raw-body ordering, idempotency keyed on Stripe IDs, atomic ledger RPC for credit adds, fail-loud-with-500-so-Stripe-retries philosophy, affiliate clawback machinery with per-row terminal states.
- **Refuse-to-guess detection ethic:** word-boundary matching, validation against known color/phase lists, UNKNOWN over wrong answer (`server.js:229–233`) — exactly right for this domain.
- **Persistent retry orchestration** with leases, cutoffs, and orphan cleanup — better than most systems this size.
- **Institutional memory in comments:** incident dates, root causes, and section references (§6.A etc.) that map to AFFILIATE_AUDIT.md. Rare and valuable.
- **Ground-truth cross-checking** against finishprobation.com plus a learnings table that accumulates labeled data for free.
- **Additive, documented migrations.**

---

## 4. Improvement Strategy

**Theme 1 — Build the safety net before touching anything else.**
*Target:* the pure detection/pricing/cutoff functions live in `lib/` modules with unit tests; CI runs tests + audit on every push; pushing to `main` with red tests is impossible.
*Principle:* this codebase's history shows regressions arrive through exactly these functions; they are cheap to test and everything else (refactor, dep upgrades) is unsafe until they are.

**Theme 2 — Close the authorization/verification edges.**
*Target:* every webhook verifies its sender; every endpoint that returns recordings/transcripts requires auth; `is_disabled` actually disables; RLS confirmed on every table.
*Principle:* the core (Stripe, admin API) is hardened — finish the perimeter to the same standard.

**Theme 3 — Make in-flight state survive a deploy.**
*Target:* a deploy at any moment loses zero notifications and zero call results. Call config persisted at initiation; long-delay notifications moved into the existing DB-poller pattern.
*Principle:* the host redeploys on every push; anything that must outlive 60 seconds cannot live in process memory. The codebase already learned this lesson for retries (`pending_retries`) — apply the same pattern to the two remaining holes.

**Theme 4 — Repo hygiene and truthful docs.**
*Target:* `git ls-files` contains only things that run or document the system; README matches reality; `.env*` fully ignored.

**Explicitly NOT recommending:** splitting into microservices or adding a queue/worker tier (single-digit-thousands of users fit one process fine); rewriting the inline-JS frontend (works, low churn); Express 5 migration (no payoff); decomposing `server.js` *before* tests exist (highest-risk move available); touching the affiliate system beyond what's listed (recently audited and hardened, currently disabled by flag).

**Definition of done (measurable):**
- CI exists and fails on test failure; ≥40 unit tests covering every function named in T1.
- Zero unauthenticated endpoints returning recordings/transcripts; Twilio signature check on all `/webhook/*` and `/twiml/*`; `is_disabled` returns 403.
- RLS verified ON for every table (screenshot/SQL output recorded in AUDIT.md).
- Kill-the-process test: restarting the server 60s after the 5:05 Fort Bend cron leaves no lost notifications.
- `npm audit` clean; stripe SDK current with pinned `apiVersion`.
- `git ls-files | wc -l` drops by ~15 junk files; README rewritten.

---

## 5. Task Plan

### Milestone 0 — Safety net (do first)

| ID | Task | Files | Acceptance | Effort | Risk | Deps |
|---|---|---|---|---|---|---|
| **M0.1** | Extract pure functions (`detectColor`, `detectPhaseColors`, `doCrossCheck`, `detectPinExpired`, `validateFtbendColor`, `computeTieredPriceCents`, `wouldExceedCutoff`, `wouldExceedFtbendCutoff`, `formatLocalDay`, `formatPhone`, `phoneticMatch`) into `lib/detection.js` + `lib/pricing.js` + `lib/time.js`; `server.js` requires them. Add `node:test` suites seeded with real transcripts from past incidents (chrome→Tan, "phase one b", PIN-expired variants). | server.js, new lib/, test/ | `npm test` green, ≥40 assertions; server.js behavior byte-identical (same exports, no logic edits) | **L** | Low-Med (mechanical move; verify with diff discipline) | — |
| **M0.2** | GitHub Actions CI: `npm ci`, `npm test`, `npm audit --omit=dev --audit-level=high`. | `.github/workflows/ci.yml`, package.json | Red X on PR/push when tests fail | **S** | None | M0.1 |
| **M0.3** ⚡ | Repo hygiene: `git rm` the 9 junk scripts, both server.js backups, `my-portfolio-site/`; add `.env.production`+`*.bak`+`*.backup` to `.gitignore`; delete tracked `.env.production`. | .gitignore, file deletions | Files gone from `git ls-files`; deploy still boots (nothing references them — verified: Procfile/railway.json run only `server.js`) | **S** | Low | — |

### Milestone 1 — Critical security & correctness

| ID | Task | Files | Acceptance | Effort | Risk | Deps |
|---|---|---|---|---|---|---|
| **M1.1** ⚡ | Enforce `is_disabled`: reject in `auth`/`adminAuth` (403), skip disabled users in `rescheduleUser`/recovery cron/Fort Bend notify. | server.js:935, 3414, 1560, 4693, 4268 | Disabled test account gets 403 on every API call and no scheduled call | **S** | Low | — |
| **M1.2** | Twilio webhook verification: `twilio.validateRequest` middleware on `/webhook/*` + `/twiml/*` (SDK already imported); additionally hard-restrict the recording fetch to `https://api.twilio.com` hosts before attaching Basic auth (server.js:2573). | server.js | Forged POST → 403; real Twilio callbacks still work (verify against a live test call) | **M** | **Med** — a validation mistake breaks the daily calls; ship behind an env flag (`TWILIO_VALIDATE=log` → `enforce`) and watch one morning in log-only mode | — |
| **M1.3** ⚡ | Auth + ownership check on `/api/recording/:sid` (user owns a `call_history` row with that SID, or is admin); strip `transcript`/`recording_url` from `/api/ftbend/today` (or require auth). Delete `public/test-auth.html`. | server.js:4441, 4463; public/ | Unauthenticated requests → 401; dashboard playback still works | **S** | Low | — |
| **M1.4** ⚡ | Fix `invoice.payment_failed`: reuse the multi-path subscription resolution from `handleSubscriptionInvoicePaid` (the `invoice.parent.subscription_details` chain) instead of gating on legacy `invoice.subscription`. Same defensive read for `charge.invoice` at 2098. | server.js:1821–1838 | Replayed current-API `invoice.payment_failed` fixture sets `subscription_status='past_due'`; unit test on the extraction helper | **S** | Low | — |
| **M1.5** | **Verify RLS** on every Supabase table (`select tablename, rowsecurity from pg_tables where schemaname='public'`); enable + add policies (or revoke anon grants) on any table that's open. Record the output in AUDIT.md. | Supabase dashboard / new migration | Query shows `rowsecurity=true` (or no anon grants) for all tables; anon-key probe from curl returns empty | **S–M** (ops) | Med — a wrong policy can break the *frontend auth flows*; test login after | — |
| **M1.6** ⚡ | Crash-proof async routes: try/catch in `/api/checkout/custom`; add `process.on('unhandledRejection')` logger; small `asyncRoute(fn)` wrapper applied to the handful of uncovered handlers. | server.js:4641 + top | Forcing a Stripe error returns 500 JSON, process stays alive | **S** | Low | — |
| **M1.7** ⚡ | Fix the two lazy no-op Supabase calls (`last_login` at 987, 3426): append `.then(()=>{},()=>{})` or await. | server.js | `last_login` column actually updates | **S** | None | — |

### Milestone 2 — High-leverage reliability & structure

| ID | Task | Files | Acceptance | Effort | Risk | Deps |
|---|---|---|---|---|---|---|
| **M2.1** | **Persist call config at initiation**: new `pending_calls` table written in `initiateCall`/`ftbendCallOffice` (keyed on `call_sid`), webhooks fall back to DB when the in-memory map misses; rows expire after 30 min. Keep the map as a fast path. | server.js:2474, 3978, 2536, 2992; migration 012 | Kill-the-process test: restart server mid-call → recording webhook still resolves user and notifies | **L** | Med — touches the core call path; lean on M0 tests + one supervised morning | M0.1–2 |
| **M2.2** | Move long-delay Fort Bend notifications off `setTimeout` into a `pending_notifications` table drained by the existing per-minute poller (same lease pattern as `fort_bend_retries`). | server.js:4300–4388, poller, migration | Restart between 5:15 and a user's 7:00 notify time → notification still sends once | **M** | Med | M2.1 |
| **M2.3** | Atomic `deduct_credit_with_ledger` RPC mirroring the add RPC (conditional `credits >= 1`, ledger row); use in `deductCreditOnce`. Same treatment for affiliate balance increments. | migration, server.js:468, 2356 | Concurrent double-deduct impossible (DB-level); ledger now shows deductions | **M** | Med (money path — test in Supabase SQL editor first) | M0 |
| **M2.4** | Dependency refresh: `stripe@22` with explicit pinned `apiVersion` (delete the legacy-field fallback reads after verifying), `node-cron@4` (API change: check `schedule` signature/timezone option), supabase-js minor. One dep per commit. | package.json, server.js | `npm audit` clean; one full live morning observed per upgrade | **M** | **Med-High** (cron + stripe are the two most load-bearing deps) | M0.2, M1.4 |
| **M2.5** | Split `server.js` into modules along the seams that already exist (`lib/notify.js`, `lib/stripe-webhook.js`, `lib/calls.js`, `lib/ftbend.js`, `routes/admin.js`, `lib/retries.js`), pure moves, one module per commit. Move `module.exports = app` to the end or add a proper `app.js`/`index.js` split. | server.js → ~7 files | Each commit: tests green, server boots, route list identical (`grep -c app\.` parity check) | **XL → break down** | Med per step | M0, M2.1 |

### Milestone 3 — Quality & polish

| ID | Task | Effort | Notes |
|---|---|---|---|
| M3.1 ⚡ | Rewrite README.md to describe the actual system (or 5 lines pointing at CLAUDE.md); mark AUDIT.md findings as fixed/open | S | Doc-only |
| M3.2 | Prune `_rateBuckets` periodically; add unique constraint for promo redemptions (`user_id, promo_code_id`) and `max_uses` check in SQL | S | C7/C8 |
| M3.3 | `checkCallHealth`: alert at ≥1 missed when total due < 8 (small-fleet mode) | S | R3 |
| M3.4 | Replace the 6 hand-rolled CST date computations with `formatLocalDay`/`todayMD` | S | C10 — after tests exist |
| M3.5 | Fix signup double-grant race (upsert + `onConflict` ignore, grant only when insert won) | S | C6 |
| M3.6 | Move webhook `purchases` insert before the credit grant (or add `stripe_invoice_id`/`session_id` uniqueness check inside the RPC) to close the C5 crash window | M | Money path — needs care |
| M3.7 | Split dashboard.html's inline JS into `public/js/dashboard.js` | M | Optional; do last |

### Quick wins (⚡ — all S effort, do immediately, independent of each other)
**M0.3** (repo hygiene) · **M1.1** (`is_disabled`) · **M1.3** (auth recording endpoints) · **M1.4** (payment_failed fix) · **M1.6** (crash-proof checkout) · **M1.7** (lazy supabase calls) · **M3.1** (README). Roughly one day total, removes two High findings.

### Implementation sketches — top 3

**M1.2 — Twilio signature validation.**
Approach: middleware `validateTwilio(req,res,next)` using `twilio.validateRequest(authToken, req.headers['x-twilio-signature'], fullUrl, req.body)`. Gotchas: (1) the URL must be the *exact* public URL including query string (`?callId=...`) — behind Railway's proxy, build it from `BASE_URL + req.originalUrl`, not `req.protocol/host`; (2) body must be the parsed urlencoded params (Twilio posts form-encoded — current `express.urlencoded` is fine); (3) roll out in log-only mode for one morning (`if (!valid) { console.error(...); if (process.env.TWILIO_VALIDATE==='enforce') return res.sendStatus(403); }`) because a false-negative blocks every daily call. Separately, in `/webhook/recording`, parse `RecordingUrl` and require `hostname === 'api.twilio.com'` before attaching the Basic-auth header — this kills the credential-leak even if validation is misconfigured.

**M2.1 — Persistent pending_calls.**
Approach: migration creates `pending_calls (call_sid pk, call_id, user_id, county, office_id, is_ftbend_daily, is_scheduled_morning, pin, target_number, notify_number, notify_email, notify_method, retry_count, transcribe_retry, created_at)`. In `initiateCall`/`ftbendCallOffice`, insert right after `calls.create` returns the SID (await it — a failed insert should log loudly but not kill the call). In `/webhook/recording` and `/webhook/status`, when `pendingCalls.get(callId)` misses, look up by... gotcha: those webhooks key on `callId` (query param), not SID — so also store `call_id` and index it; Twilio also posts `CallSid` in the body, use `req.body.CallSid` as the primary recovery key. Reconstruct the `config` object from the row and proceed; delete the row in the same places the 10-min `setTimeout` cleanup runs, plus a daily cron sweep for stale rows. Keep `pendingCalls` map as the hot path so behavior is unchanged when no restart happened. Test: deploy a no-op commit 60s after triggering a manual call; confirm the result still lands.

**M0.1 — Extract + test pure functions.**
Approach: create `lib/detection.js` exporting the functions *by moving the exact code*, no edits; `server.js` destructures them at the top. Gotchas: (1) `doCrossCheck` mutates the shared `FTBEND_MISRECOGNITIONS` map — export the map from the module so server.js and tests share the same reference, and have tests reset it in `beforeEach`; (2) `detectColor` logs via `console.log` — fine, don't refactor logging in the same commit; (3) `wouldExceedCutoff` depends on `Intl` with IANA zones — assert against fixed UTC instants (e.g. `2026-06-11T19:01:00Z` = 14:01 CDT → true). Seed cases from documented incidents: `"the color for today is chrome"` → `Chrome` (not Tan); `"Spanish"` in transcript → no Tan coercion; `"today is prep and phase one b"` → `{phase1:'Prep', phase2:'Phase 1 b'}`; `"your i.d. number has expired"` → PIN_EXPIRED; `computeTieredPriceCents(1)===500`, `(30)===1500`, `(31)===1542`, `(91)===4053`.

---

## 6. Open Questions (need a human)

1. **RLS (blocking, ties to S3):** Run `select tablename, rowsecurity from pg_tables where schemaname='public';` in Supabase. Are `profiles`, `user_schedules`, `call_history`, `purchases`, `affiliate_earnings`, `payout_requests`, `referrals`, `promo_codes`, `daily_county_status`, `pending_retries`, `fort_bend_retries` all `true` (or anon-revoked)? Everything about the published anon key's safety hinges on this.
2. **Is the affiliate program coming back?** It's flag-disabled (`AFFILIATE_ENABLED`, server.js:264). If it's permanently dead, ~800 lines and several admin endpoints are deletion candidates rather than maintenance burden. If it's returning, M2.3's atomic balance work matters more.
3. **Staging appetite:** would you accept a second Railway service (deploy-on-branch `staging`) + a Stripe test-mode env? It's the single biggest process improvement available, but it costs a few dollars/month and some Twilio test wiring. Without it, M1.2 and M2.4 carry real morning-call risk.
4. **`/api/ftbend/today` exposure:** is the public color display intentional marketing (the landing page may use it)? If yes, keep colors public and strip only `transcript`/`recording_url`; if no, put it behind auth.
5. **Step 5 of CLAUDE.md (`<Gather>` revival)** is still pending — should it stay on the roadmap? M2.1/M2.2 (deploy-safe state) should land first either way, since Gather adds more in-flight state.
6. **Old data cleanup:** `purchases` rows from before migration 006 can't be matched for clawbacks (noted at server.js:1937–1940). Acceptable, or worth a backfill script?

---

## 7. Review coverage note

Deep review: all 4,994 lines of `server.js`, all 11 migrations, git history (364 commits, secret scan across all blobs), deploy configs, dependency tree, `admin.html`, `test-auth.html`, and structural review of the other public pages. **Lighter review:** the inline JS bodies of `dashboard.html` (2,137 lines) and `index.html` — checked for embedded keys and direct DB access (none found; they use the anon key for auth only and call the server API), but their UI logic was not line-audited. The Supabase-side schema/RLS/RPC definitions (`add_credits_with_ledger`) live outside the repo and could not be reviewed — flagged in Open Questions.
