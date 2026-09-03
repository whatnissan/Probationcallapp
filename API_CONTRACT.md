# ProbationCall API Contract v1

Shared spec between `whatnissan/Probationcallapp` (Express/Railway) and
`whatnissan/probationcall-ios`. **Put a copy at the root of both repos.**
Neither side changes this unilaterally — edit the spec first, then implement.

---

## 0. Why this exists

The iOS app currently renders entirely from `MockData`. Nothing is real until
these endpoints exist. This document is the boundary: the backend implements it,
the app consumes it, and the mock fixtures should be reshaped to match it exactly
so swapping mocks for the real client is a one-file change.

---

## 1. Conventions

**Base URL** `https://www.probationcall.com/api/v1`

Version in the path. When a breaking change is needed, ship `/api/v2` alongside —
never mutate v1's shapes. Shipped app versions cannot be forced to update.

**Auth** Supabase JWT as a bearer token on every request except where noted.

```
Authorization: Bearer <supabase_access_token>
```

Reject with `401` and `{"error":{"code":"unauthenticated"}}` on missing/expired
tokens. The client refreshes via Supabase and retries once.

**Content type** `application/json` both directions. UTF-8.

**Timestamps** ISO 8601 with offset, always. `"2026-08-20T06:00:29-05:00"`.
Emitted values may include fractional seconds (Postgres emits microseconds)
and may use `Z` instead of a numeric offset — e.g.
`"2026-08-24T13:01:49.007851Z"`. Clients must accept all of these variants.
Never bare dates for events. Calendar days (a testing date) use `"2026-08-20"`
and are interpreted in the user's `timezone`.

**Money** integer cents. Never floats.

**Nulls** A field that is absent and a field that is `null` mean the same thing.
Don't use empty string as a null stand-in.

### Error shape

Every non-2xx returns:

```json
{
  "error": {
    "code": "insufficient_credits",
    "message": "You have no credits remaining.",
    "retryable": false
  }
}
```

`code` is a stable machine string — the client branches on it.
`message` is user-presentable and safe to display.
**Never leak Postgres errors or schema details into `message`.** The backend
already learned this the hard way with the Fort Bend `pin` not-null constraint.

Standard codes: `unauthenticated`, `forbidden`, `not_found`, `validation_failed`,
`insufficient_credits`, `rate_limited`, `outside_call_window`, `schedule_missing`,
`internal`, `billing_cancel_failed`, `unpaid_affiliate_earnings`,
`account_deletion_blocked` (all three §4.15), `phone_not_verified` (§4.7),
`referral_already_applied`, `referral_after_purchase` (both §4.14),
`sms_opted_out`, `sms_send_failed`, `verification_not_found`,
`verification_expired`, `verification_locked`, `verification_incorrect`
(§4.17).

### Rate limiting

`429` with `Retry-After` in seconds. Test endpoints keep the existing 3-per-5-min.

### Unknown enum values — MANDATORY

Every enum below may gain values without a version bump. **Clients must decode
unrecognized values into an `unknown(String)` case and degrade honestly** — show
the raw value, offer support, and never guess a remedy.

This is not theoretical. The app already shipped a `PauseReason` that decoded
everything non-`no_credits` as "user paused," which would have shown a Resume
button to someone auto-paused for an expired PIN.

---

## 2. Enums

### `county`
`"montgomery"` — PIN-based. `"ftbend"` — color-based.
These are the strings already in `user_schedules.county`. Don't rename them.

### `result`
The outcome of a day's call.

| Value | Meaning | Bills a credit |
|---|---|---|
| `MUST_TEST` | User must report today | Yes |
| `NO_TEST` | User is not required today | Yes |
| `UNKNOWN` | Transcription unusable | **No** |
| `HOTLINE_DOWN` | Hotline unreachable | **No** |
| `CALL_FAILED` | Call never connected | **No** |
| `PIN_EXPIRED` | PIN no longer valid at the hotline. Montgomery only | **No** |
| `WRONG_PIN` | PIN rejected as incorrect. Montgomery only. **Aspirational — not currently emitted**: the backend cannot yet distinguish a wrong PIN from an expired one. Clients keep the distinct UI so improved detection needs no client change. | **No** |
| `IN_PROGRESS` | Call running or retries pending | n/a |
| `SCHEDULED` | Enabled; this morning's call hasn't started yet. The user's answer is "wait" | n/a |
| `NOT_CALLED` | Schedule paused/disabled; no call made. The user's answer is "nothing is coming" | n/a |

`SCHEDULED` and `NOT_CALLED` are deliberately separate states: overloading
`NOT_CALLED` for "enabled but not yet called" renders the paused card — with a
Resume affordance — at 5:02 AM on a perfectly healthy schedule.

`billed: bool | null` is returned explicitly per call — the client displays
"you were not charged" from `billed === false`, never inferring it from the
result. `true`/`false` only once a call has resolved; `null` means no billable
outcome exists yet (`SCHEDULED` / `IN_PROGRESS` / `NOT_CALLED`).

### `pause_reason`
`null` when active.

| Value | Auto-resumes on credit top-up | Remedy |
|---|---|---|
| `no_credits` | **Yes** | Buy credits. No Resume button — it'd be dead. |
| `unknown_streak` | No | Call the hotline yourself; check whether the PIN changed |
| `pin_expired` | No | Contact your officer for a new PIN |
| `user` | No | Resume |

Auto-resume is scoped `.eq('paused_reason','no_credits')` server-side. Do not widen.

### `notify_method`
`push`, `sms`, `email`. Multiple allowed — see §4.7. (`whatsapp` removed
2026-08-24 — unreliable in production; zero users had it at removal.)

**`push` COMPOSES with the others; it does not replace them.** Push is the
fast path and SMS is the backstop: push fires first, and if it is not
acknowledged within `PUSH_SMS_FALLBACK_MINUTES` (10) the SMS goes out anyway.
That preserves the delivery guarantee while cutting Twilio spend, which is the
actual return — a push-only guarantee would be no guarantee at all, because a
phone can be off.

**A dead token does NOT wait out the timer.** If APNs rejects the send
(`Unregistered`, `BadDeviceToken`), or the user has no live device, or the
send fails for any other reason, the SMS goes immediately. We already know
push failed at that point, and `MUST_TEST` is not a result to gamble ten
minutes on.

**Push covers both counties.** Montgomery pushes from the per-user call
result. Fort Bend pushes from the per-user notification queue, at the user's
preferred send time, one delivery row per user per morning — one office
announcement fans out to N independent deliveries, each with its own ack and
its own fallback timer. `UNKNOWN` never pushes in either county: "call the
hotline yourself" is an action item and goes out as SMS/email as it always has.

**One delivery row owns the morning.** If a retry reaches the push step and a
`push_deliveries` row already exists for that user and date, the server sends
NOTHING more: that row has either pushed (the timer will text if unread), is
already due for fallback, or has already texted. Every existing row leads to
exactly one notification.

**Quiet mode is enforced on every channel (since 2026-09-02).** A `NO_TEST`
for a quiet-mode user is not delivered at all — no push, no SMS, no email — but
it is still recorded in history and still billed. `MUST_TEST` and `UNKNOWN` are
always delivered.

**Billing is unaffected.** A push-only morning still bills a credit: the credit
pays for the call to the hotline, not for the delivery of the answer.

### `ftbend_office`
`missouri` (Probation, 3668) · `rosenberg` (Pretrial, 3669) · `rosenberg2`
(Drug Court, 3671). Values match `user_schedules.ftbend_office`.

---

## 3. The bootstrap call

### `GET /me`

One request that returns everything needed to render the app's first frame.
The app calls this on launch and after returning from checkout. **At 5 AM on a
bad connection, one round trip beats five.**

```json
{
  "user": {
    "id": "uuid",
    "email": "dave@example.com",
    "displayName": "Dave R.",
    "isAdmin": false,
    "createdAt": "2026-05-02T14:22:10-05:00"
  },
  "phone": { "verifiedNumber": "+12815550142", "verifiedAt": "2026-09-02T20:41:07Z" },
  "credits": {
    "balance": 47,
    "probationEndDate": "2027-01-02",
    "daysRemaining": 142,
    "creditsNeeded": 95,
    "lowBalance": false
  },
  "schedules": [
    {
      "id": "uuid",
      "county": "montgomery",
      "pin": "482913",
      "ftbendOffice": null,
      "ftbendColor": null,
      "callTime": "06:05",
      "timezone": "America/Chicago",
      "callWindow": { "opensAt": "06:00", "closesAt": "14:59", "retryCutoff": "14:00" },
      "enabled": true,
      "pauseReason": null,
      "noCreditSkipCount": 0,
      "consecutivePinExpired": 0,
      "notifyMethods": ["push", "sms"],
      "notifyNumber": "+18325551234",
      "notifyEmail": "dave@example.com",
      "quietMode": false
    }
  ]
}
```

**`schedules` is an array even though it always has exactly one element today.**
`user_schedules` is one row per user keyed on `user_id`, and dual-county is
unsupported — but if that ever changes, an array bends and a singleton breaks.
The client renders `schedules.first` and must not crash on zero or two.

**Zero schedules means the user hasn't onboarded.** That's the signal to route
into the onboarding flow, not an error.

**`daysRemaining` goes NEGATIVE once the probation end date has passed** —
`-42` means it ended 42 days ago. It was clamped at 0 until 2026-08-28, which
made "today is your last day" and "your date passed six weeks ago" the same
value; the app rendered the second as "covered through the end". `0` now means
exactly one thing: today is the last day. A sign is unmissable, where a
separate `ended` boolean would be a field a client can forget to check —
and forgetting lands straight back on "0 days left".

**`creditsNeeded` stays clamped at 0** and never goes negative: you do not
need credits for days that have already elapsed. So the two fields diverge
once the date passes, deliberately.

**`ftbendColor` is sourced from `profiles.user_color`** — the color lives on
the profile, not the schedule row. The serializer joins it in; clients should
not care, but whoever touches the backend should know where it comes from.

**`GET /me` is the one deliberate exception to `authV1`'s no-side-effects
rule:** when no profile row exists it bootstraps a ZERO-credit one. For an
iOS-first signup, `/me` IS first touch — refusing to create the profile would
strand the account. Every other v1 endpoint stays side-effect-free on read.

**Starter credits come from the database, not the app (2026-09-02, migration
044).** A trigger on auth user creation creates the profile and grants
`starter_credits` (an `app_settings` row, 5 today, editable for a promotion
without a deploy) through the ledger, and withholds it — with a zero-amount
audit row — when the email matches a deleted-account tombstone. So a fresh
account normally arrives at `/me` already holding its starter credits, and a
re-signup after §4.15 deletion arrives with **0**. Clients render the balance
they are given; there is no client-side notion of a signup bonus.

**Hand grants are over (2026-09-02).** Sixteen admin grants taught people to
wait for a top-up rather than buy. The answer a user gets is the answer the
product gives. An EARNED extension exists (`apply_earned_extension`, settings
`earned_grant_*`: low balance AND real billed results AND a MUST_TEST, capped
per account, withheld while a review flag is open) but is **held** behind
`earned_grant_enabled=false` until the September paywall cohort resolves.

**`pin` is returned in full, not masked.** It's the user's own PIN, on their own
authenticated device, and they need to read it aloud while dialing the hotline
themselves. Masking it removes utility and protects nothing.

Fort Bend variant differs only in the identity fields:

```json
{
  "county": "ftbend",
  "pin": null,
  "ftbendOffice": "missouri",
  "ftbendColor": "zinc",
  "callTime": "05:05",
  "callWindow": { "opensAt": "05:00", "closesAt": "09:00", "retryCutoff": "09:30" }
}
```

---

## 4. Endpoints

### 4.1 `GET /today`

The morning result. Supports `If-None-Match`; return `304` when unchanged so the
app can poll cheaply during the retry window.

```json
{
  "date": "2026-08-20",
  "scheduleId": "uuid",
  "county": "montgomery",
  "result": "MUST_TEST",
  "billed": true,
  "resolvedAt": "2026-08-20T06:00:29-05:00",
  "attempt": 1,
  "maxAttempts": 1,
  "nextAttemptAt": null,
  "retryCutoffAt": null,
  "pauseReason": null,
  "callLog": [
    { "at": "2026-08-20T06:00:02-05:00", "kind": "dial",   "text": "dialing Montgomery hotline" },
    { "at": "2026-08-20T06:00:29-05:00", "kind": "result", "text": "MUST_TEST" }
  ],
  "recording": {
    "callId": "uuid",
    "durationSeconds": 14,
    "transcript": "Client four eight two nine one three is required to report..."
  },
  "fortBend": null
}
```

There is **no `detail` field** (dropped 2026-08-25): the client owns result
copy — it can localize and restyle; a server string can't. And there is **no
`matchConfidence`** on `recording`: Montgomery matching is keyword substring
with no score, and inventing one is the pseudo-confidence pattern §4.10 bans.

`recording.durationSeconds` is `int | null` — written by the recording webhook
since migration 034; calls recorded before 2026-08-25 stay `null` (this also
applies to `durationSeconds` in §4.2 rows and §4.4).

`callLog[].kind` ∈ `dial` `connect` `ivr` `dtmf` `record` `transcribe` `color`
`match` `result` `retry` `busy` `error`. Drives the timeline node styling.
**Currently emitted: `dial` `retry` `error` `result` only** — the log is
synthesized from durable data (`call_attempts` + `call_history`), and the
richer kinds were never persisted anywhere. Emitting them requires a
`call_events` table (backlogged, not built); until then a fuller log would be
a fake narration of a real call. Clients must render whatever subset arrives.

`nextAttemptAt` / `retryCutoffAt` are non-null only during **Montgomery**
retries — per-user retries are Montgomery's `pending_retries` machinery.
Fort Bend retries are office-level and invisible per user. (This sentence
previously said Fort Bend; it was backwards.)

For Fort Bend, `fortBend` carries the office board:

```json
"fortBend": {
  "yourOffice": "missouri",
  "yourColor": "zinc",
  "offices": [
    { "office": "missouri",   "program": "Probation",  "code": "3668",
      "announced": ["zinc"], "phases": null, "heardAt": "2026-08-20T05:06:47-05:00" },
    { "office": "rosenberg",  "program": "Pretrial",   "code": "3669",
      "announced": ["zinc"], "phases": null, "heardAt": "2026-08-20T05:07:12-05:00" },
    { "office": "rosenberg2", "program": "Drug Court", "code": "3671",
      "announced": null, "phases": ["2","3"], "heardAt": "2026-08-20T05:08:03-05:00" }
  ]
}
```

`announced` and `phases` are mutually exclusive. Both `null` means not heard yet.
Rosenberg 2 is the office that reports phases.

**Enabled schedules with no activity yet today** get `result: "SCHEDULED"`
with `attempt`/`maxAttempts`/`billed` null and an empty `callLog` — the
morning call simply hasn't started. Never render this as paused.

**Paused users** get `result: "NOT_CALLED"` with the schedule's `pauseReason`
echoed, an empty `callLog`, and null `recording`. (Schedules paused before
pause-reason tagging shipped carry `pauseReason: null` — render the generic
paused state.)

---

### 4.2 `GET /history`

```
?limit=25&cursor=<opaque>&result=MUST_TEST
```

Cursor pagination — offset pagination breaks when rows land mid-scroll.
`cursor` is opaque; pass back exactly what `nextCursor` gave you.

```json
{
  "items": [
    {
      "callId": "uuid",
      "date": "2026-08-20",
      "result": "MUST_TEST",
      "billed": true,
      "resolvedAt": "2026-08-20T06:00:29-05:00",
      "county": "montgomery",
      "summary": "PIN called · Conroe",
      "attempts": 1,
      "hasRecording": true,
      "durationSeconds": 14,
      "userConfirmedTested": true
    }
  ],
  "nextCursor": "eyJpZCI6...",
  "hasMore": true
}
```

List rows deliberately omit transcript and log — fetch those per call.

**Several fields are derived or unknowable, and say so honestly rather than
guessing.** The backend never invents a value to satisfy a type:

- **`result` is MAPPED, not stored.** `call_history.result` is an operational
  string that predates this enum: `RETRY_PENDING` → `IN_PROGRESS`,
  `NO_CREDITS` → `NOT_CALLED`, `TRANSCRIBER_DOWN` / `RECORDING_UNAVAILABLE` →
  `UNKNOWN`. Anything unrecognised maps to `UNKNOWN`.
- **Fort Bend rows store the office ANNOUNCEMENT, not the user's verdict.**
  Since 2026-08-27 the verdict is recorded at call time (with the colour it
  was matched against) and is served as-is. Older rows have no verdict, so it
  is re-derived by comparing the announcement to the user's *current* colour —
  a best effort that is wrong if their colour ever changed. Either way
  `summary` carries the raw announcement, so the underlying fact is always on
  screen.
- **`summary` is derived, not stored** — e.g. `"PIN 482913 · Montgomery
  County"`, `"Auburn announced · Missouri City"`, `"Skipped — out of credits ·
  Rosenberg 2"`. There is no location data anywhere in the system, so the
  place is the county or office, never a city like "Conroe". (§4.18's office
  directory is public information about county buildings, not about the user
  — it does not change this.)
- **`attempts` is `int | null`** — null for calls before 2026-08-15, when
  dial-time logging (`call_attempts`) began. Those calls have no attempt
  record at all, and `1` would be a number we made up.
- **`billed` is `bool | null`** — `billed_at` was only added on 2026-05-19,
  and most historical billable rows predate it. Credits *were* deducted then;
  there is simply no marker. Unrecorded therefore reads as `null` (unknown),
  never `false` — because the client renders "you were not charged" from
  `false`, and that would deny a charge the user actually paid.
- **`userConfirmedTested` is always `null`** until §4.5 ships; nothing stores
  a confirmation yet.
- **`hasRecording` is usually `false`** on older rows — see the 30-day
  retention note in §4.4.

**Filtering by `result` can return an empty page with `hasMore: true`.**
Because the enum value is computed rather than stored, the filter cannot run
in SQL; the server walks a bounded number of raw pages per request. An empty
page is not the end of the list — keep following `nextCursor` until
`hasMore` is `false`.

### 4.3 `GET /calls/{callId}`

Full detail for one past call: same shape as `/today`'s `callLog` + `recording`.

### 4.4 `GET /calls/{callId}/recording`

```json
{ "url": "https://www.probationcall.com/api/recordings/RE…?t=…",
  "expiresAt": "2026-08-27T14:15:00Z", "contentType": "audio/mpeg",
  "durationSeconds": 14 }
```

**Short-lived capability link, never a permanent public link.** This is audio
about a named person's probation status. 15-minute expiry; the client
re-fetches rather than caching the URL. Caching the *audio* locally is fine.

**How this actually works** (the original spec asked for a signed URL, which
the storage cannot provide). Recordings live at Twilio's REST media URL, which
is *not* public — it returns 401 without our account credentials — but Twilio
offers no per-object signing, and those credentials must never reach a client.
So the server mints its own capability token: HMAC-SHA256, scoped to ONE
recording, 15-minute expiry, constant-time verified, and proxies the audio.

The token is deliberately **not** a Supabase JWT. A session credential in a
query string lands in browser history, proxy logs and Referer headers, and
stays valid for the life of the session; a capability token grants one
recording for fifteen minutes and nothing else. (Two routes did exactly this
until 2026-08-27 and were deleted.)

**Recordings are deleted from Twilio after 30 days.** Most history therefore
has no audio: `hasRecording` is `false` on those rows and this endpoint
returns `404 not_found`. That is the honest answer, not an error to retry.

`durationSeconds` is `int | null` — null for calls recorded before 2026-08-25,
when duration capture began (§4.1).

**Honour `contentType`.** The App Review demo account (§4.16) carries one
synthetic recording — speech-synthesised audio we made, never a hotline
capture — served as a static `audio/mp4` file rather than a proxied Twilio
MP3. Nothing else about the response differs.

### 4.5 `POST /calls/{callId}/tested`

User check-in — `{"tested": true}`. Real ground truth for the prediction model,
and it builds the compliance record. Idempotent.

### 4.6 `POST /calls/{callId}/report`

Wrong-result correction. `{"reportedResult":"NO_TEST","note":"color was tan"}`.
Feeds `fort_bend_learnings`. This is a second ground-truth source from the person
who actually drove to the office — worth more than it looks.

### 4.7 `PUT /schedule`

Full replace, mirroring the existing `/api/schedule` upsert. Body is the schedule
object from §3 minus server-owned fields (`id`, `pauseReason`, counters).

Server-side rules that already exist and must be preserved: re-saving forces
`enabled: true`, clears `consecutive_pin_expired`, and clears `paused_reason`.
Montgomery writes `pin` and null office/color; Fort Bend writes null `pin`.

**`callTime` and `notifyMethods` are REQUIRED, and a missing one is a `400`
naming the field — never a default.** PUT is a full replace, and this endpoint
briefly did the opposite: it read `hour`/`minute`/`notifyMethod` while this
section documented `callTime`/`notifyMethods`, so a correct payload fell
through to 06:00 email-only and silently moved a live call time. For this
product, saving something other than what the caller sent is the worst
available outcome — a partial payload must not be able to reset when we call
or how someone is reached. The legacy `hour`/`minute`/`notifyMethod` shape is
still accepted so older builds keep working, but one of the two shapes must be
present.

`callTime` is `"HH:MM"` and is validated: a malformed string or an impossible
time is a `400` naming `callTime`, not a silent fallback.

**Call-time floors (2026-09-02).** Montgomery accepts `06:00`–`14:59` only;
Fort Bend accepts `05:10` or later. Outside that is a `400` naming
`callTime`. Before 6:00 a Montgomery call would reach the hotline before the
county records the day's announcement and report yesterday's answer as
today's — the server must not accept a time it cannot honour. Fort Bend's
office call is fixed at 5:05, so the user's time is only when they are told.
Onboarding should offer a picker with 06:00 preselected, not a fixed default.

**SMS requires a verified number (2026-09-02, v1 only).** If `notifyMethods`
includes `sms`, `notifyNumber` must equal `/me`'s `phone.verifiedNumber`, or
the write is refused with `400 phone_not_verified`. Verify first (§4.17).
The website keeps its current behaviour so live web schedules are not
stranded.

**`push` in `notifyMethods` is accepted but NOT stored in `notify_method`.**
Push is driven by registered devices (§4.12), so the column only records the
`sms`/`email` part and the response echoes what was actually saved — a caller
who sends `["push","sms"]` gets `["sms"]` back and can see the difference.
`["push"]` alone is rejected: §2 makes SMS the backstop, and push with no
fallback is no delivery guarantee at all.

**`ftbendColor` is writable here.** It resolves through the server-owned colour
catalogue (§4.11), so an unrecognised colour is a `400` naming `ftbendColor`
rather than a value that silently never matches an announcement. It is stored
on `profiles.user_color`, and sending it with a Montgomery schedule is a `400`
— colour has no meaning there.

**`probationEndDate` is writable here (2026-09-02).** `"YYYY-MM-DD"` or
`null` to clear; stored on `profiles.probation_end_date` and read back from
`/me`. A malformed or impossible date is a `400` naming the field. The app
must no longer post it to the website's `/api/profile/probation-end`.

**The first schedule sends the welcome (2026-09-02).** When `PUT /schedule`
creates a schedule for an account that had none, one welcome message goes
out on the channels just chosen ("Your daily check-in is now active…"). It
used to live only in the website's route, so app signups got nothing. A
re-save is not a first schedule and sends nothing.

**Shared phone numbers are flagged, never refused (2026-09-02).** A notify
number already on another account's schedule opens a review flag for the
daily admin digest. The schedule saves normally and the client sees nothing
different: one person managing a family member's account is legitimate, and
being unable to sign up is worse than someone farming. An open flag withholds
only the earned extension.

### 4.8 `POST /schedule/pause` · `POST /schedule/resume`

**This endpoint does not exist yet and the app's pause UI depends on it.**

Pause takes `{"reason":"vacation until 9/2"}` and writes `enabled=false`,
`paused_reason='user'`. Resume writes `enabled=true, paused_reason=null`.

Resume must **reject with `insufficient_credits`** when balance is zero rather
than enabling a schedule that will immediately re-pause.

### 4.9 Test tools — `POST /test/call` · `/test/sms` · `/test/email`

None consume credits. Existing rate limits stand.

`/test/call` is only valid inside the county's window — outside it, return
`outside_call_window` with the window in `message`. Returns a `callId` the client
polls via `/calls/{id}` until it resolves.

This is the final step of onboarding: prove the PIN or color actually resolves
before the user starts depending on the service.

### 4.10 `GET /prediction`

**The reason this whole contract exists.** The prediction math lives in ONE
module — `public/prediction-core.js` — `require()`d by the backend for this
endpoint and unit-tested in `test/prediction.test.js`. The web dashboard calls
this endpoint; it no longer computes locally. Clients must not reimplement the
math: this is the number people make decisions on, and two implementations
drift. (Verified at migration: server and client paths produced identical
output for all 15 production users.)

```json
{
  "county": "montgomery",
  "nextWindow": { "startDays": 1, "endDays": 15 },
  "yourIntervalDays": 12.0,
  "countyAverageIntervalDays": 21.5,
  "daysSinceLastTest": 4,
  "testsCounted": 15,
  "observationDays": 197,
  "testsPerMonth": 2.3,
  "recentTests": ["2026-07-16", "2026-07-25", "2026-07-29", "2026-08-04", "2026-08-17"],
  "rapidRetestsIncluded": 3,
  "unobservedGapsExcluded": 0,
  "escalation": { "lastGapDays": 4, "medianDays": 14.5 },
  "dayOfWeek": null,
  "dayOfWeekSuppressed": "needs 35+ tests (15 so far)",
  "weekOfMonth": null,
  "countyDayPattern": { "total": 72, "weekendCount": 2, "fullWeekSignificant": true, "weekdaySignificant": false },
  "basedOn": "your history",
  "notes": ["Rapid retests are included in interval math — a quick re-call is the county's escalation signal.",
            "The window is a range, not a promise: testing is possible any day."]
}
```

Field by field. Every nullable field means "the data does not support this
claim yet" — clients render the absence honestly, never a zeroed chart.

- **`nextWindow`** `{startDays:int, endDays:int} | null` — populated ONLY
  when `window.state === 'two_number'` (below); otherwise `null`. There is
  deliberately **no `peakDays` and no `confidence`**: the previous confidence
  score was `min(88, max(40, …))` — a clamped heuristic with no
  probabilistic meaning whose floor made thin data look moderately certain.
  A number that looks rigorous and isn't is worse than no number. The same
  ban removed `recording.matchConfidence` from §4.1 (2026-08-25): keyword
  matching has no score, so any "confidence" there would be invented. Do not
  reintroduce a confidence number anywhere in this API without a real
  probabilistic model behind it. Headline
  copy labels any band **"recent historical range"** — never "most likely"
  or any probabilistic wording — and always pairs it with "possible any day".
- **`window`** `{state, innerDays, outerDays, intervalsUsed, needed,
  scoredOrigins, innerCoverage}` — the window classification, three states.
  **`needed` is ALWAYS present** (the MIN_PRIORS gate, 5) as of 2026-09-02.
  It used to appear only on `insufficient`, which left clients decoding
  `undefined` elsewhere and unable to tell "gate not applicable" from "gate
  unknown". "9 intervals against a gate of 5" is as useful as "2 of 5".
  **Units: `innerDays` and `outerDays` are INTERVAL LENGTHS (days between
  tests); `nextWindow` is days FROM NOW.** Clients must never place the two
  frames side by side unlabeled — display both bands in the interval frame
  and show days-since-last-test as its own fact, or the inner band appears
  to escape the outer (inner minus elapsed days starts below the outer
  minimum).
  - `two_number`: `innerDays` = recency-weighted P10–P90 of completed
    intervals (half-life 4 intervals, rounded outward), labeled "recent
    historical range"; `outerDays` = min–max, presented as "has ranged X–Y".
    Granted only when the user's own walk-forward self-test clears
    ≥3 scored origins at ≥70% inner-band coverage.
  - `irregular`: the self-test failed — no narrow window is defensible.
    Clients show "too irregular to narrow" with `outerDays` as a fact about
    the past, never as a forecast. This and `insufficient` are the PRIMARY
    states (14 of 15 users at introduction) — design them as the main
    experience, not a fallback.
  - `insufficient`: fewer than `needed` (= 5) completed intervals — no
    personal bands of any kind. Since 2026-09-02 this state MAY carry
    `countyRange` (below); without it, show "not enough history yet (n of 5)".
- **`window.countyRange`** `{lowDays:int, highDays:int, mass:0.8,
  basedOnIntervals:int, basedOnUsers:int} | null` — **present ONLY when
  `window.state === 'insufficient'`; always `null` in the other two states.**
  The central 80% of a kernel density over every completed interval of
  OTHER people in the same county — the requesting user's own intervals are
  excluded, so the band cannot drift toward their pattern, and so are internal
  accounts (admins, dev emails, `INTERNAL_ACCOUNT_EMAILS`): "people in
  Montgomery County" means people on probation, not us. `null` when the pool
  is under **20 intervals from 3 users** (Fort Bend today) — then the county
  fact is not measurable either, and nothing is shown. Built by the same
  interval rules as the personal model (`intervalsOf`), cached an hour.

  **Why it exists (2026-09-02 backtest, second set).** For users with 2–4
  intervals — 11 of 15 at the time — their own envelope covered 41% of a
  separate 17-origin walk-forward set; this county-pooled-only band covered
  **88% with a 10-day worst miss**, and beat a hierarchical blend (82%,
  wider) while being literally what the copy claims.

  **Copy — APPROVED 2026-09-02, render as written.** Own heading, county
  named in it, never in the slot the personal band occupies, never coloured
  as a forecast:

  > **Not enough of your own history yet (3 of 5 intervals)**
  > People in Montgomery County typically go 9 to 42 days between tests.
  > That's the county, not you. You don't have enough of your own history
  > yet to say whether you differ. Testing is possible any day.

  Zero intervals: headline "Prediction unlocks after your first required
  test", then the county sentence, then "That's the county, not you. Testing
  is possible any day." Pool too small (`countyRange` null): "Your county's
  pattern isn't measurable yet either. Testing is possible any day."

  **BANNED WORDS for this band — load-bearing, not style:** `your`,
  `usual`, `likely`, `expected`, `most`. Each one turns a county fact into a
  personal prediction, and each is exactly what a well-meaning future edit
  would reintroduce. Words that ALWAYS appear: the county's name, "not you",
  "possible any day". The server ships the "not you" sentence in `notes`
  whenever `countyRange` is present, so the framing travels with the number.

  **Methodology (2026-08-25 backtest — read before proposing to narrow the
  window).** Walk-forward, leakage-free, 17 forecast origins across all
  production history: the old always-on min–max envelope missed **35%**
  prospectively — most misses are new record extremes, which an envelope
  cannot contain by definition, so it was never "wide but honest".
  Every tighter fixed band traded width for MORE misses (P10–P90: 59%
  coverage; P20–P80: 41%), and the extra misses landed on escalation
  days — the highest-stakes forecasts. Whoever next proposes narrowing
  must beat those numbers on the same walk-forward method first.

  **Second backtest (2026-09-02) — the bar is now this.** Same 17 origins,
  same method, four new families tested: per-user parametric fits
  (lognormal, Weibull), a county-pooled hierarchical model, day-of-week ×
  week-of-month conditioning, and a post-escalation regime. Full method
  table, per-origin chart and copy drafts:
  https://claude.ai/code/artifact/2060e3f6-beec-4a0a-a589-40f1337fc079

  | method (17 origins) | cover | miss | mean width | worst miss | paired vs min–max |
  |---|---|---|---|---|---|
  | min–max envelope (shipped outer) | 65% | 6 | 27.4 | 37 | — |
  | recency P10–P90 (shipped inner) | 65% | 6 | 25.9 | 37 | +0 / −0 |
  | best at EQUAL width (lognormal, HDR-placed) | 76% | 4 | 27.4 | 35 | +2 / −0 |
  | hierarchical lognormal 80% | 82% | 3 | 36.4 | 15 | +3 / −0 |
  | calendar-conditioned / regime | 71% | 5 | 26.7 | 31 | +1 / −0 |

  **Verdict: the window stays.** At equal width nothing gains more than two
  hits, worst-case miss distance does not improve, and the noise floor is a
  12-point standard error — a paired method needs six net wins for
  p<0.05, and ~50 origins exist only a year from now. Calendar
  conditioning carries zero signal (72 county tests over 35 cells).
  Post-miss clustering is not modellable (5 such intervals in all history).
  The hazard framing forecasts identically at the origin; its real product
  is the past-range state below.

  **Where pooling DOES work: the gated-out users.** On a SEPARATE
  17-origin set of users with 2–4 intervals (not comparable to the table
  above), their own envelope covered 41%; a county-pooled-only 80% band
  covered 88% with worst miss 10 days. A `window.countyRange` for the
  `insufficient` state is DRAFTED (copy and classification on the page
  above), not built — it ships only as a county fact, never as the user's
  pattern, and only after the copy is approved.
  **MIN_PRIORS = 5** because below 5 completed intervals each observation
  carries ≥20% of the distribution's mass — a "percentile" of fewer
  points is a single data point in costume. Sample sizes count COMPLETED
  INTERVALS (N tests → N−1 intervals), never tests.
- **`yourIntervalDays`** `number | null` — recency-weighted mean interval
  (exponential decay, half-life 4 intervals), blended toward the county
  average when personal history is thin (full personal weight at 8+
  intervals; `basedOn` names the mix). Recency weighting exists so a
  post-miss escalation moves the estimate within 2–3 tests.
- **`daysSinceLastTest`** `int | null`, **`testsCounted`** `int`,
  **`observationDays`** `int`, **`testsPerMonth`** `number` — plain counts.
  Sample size IS the honesty signal; display it wherever the interval shows.
- **`recentTests`** `["YYYY-MM-DD"]` — the user's last ≤6 MUST_TEST dates.
  Real history for display; no inference.
- **`rapidRetestsIncluded`** `int` — count of sub-7-day gaps, which are
  **INCLUDED in interval math**. They are the county's escalation response
  to a missed test — exactly the signal the model exists to catch. The old
  model excluded them as "retests" and thereby deleted the evidence
  (16.2d shown vs 12.0d actual for the user who surfaced this). Do not
  re-add the exclusion.
- **`unobservedGapsExcluded`** `int` — gaps ≥60 days are included only when
  call coverage across the gap is ≥60% (we were watching and the county
  genuinely didn't call — a real 63-day cadence with 91% coverage exists in
  production). Low coverage means the schedule was off: an observation hole,
  not cadence. This counts the dropped ones so exclusion is never silent.
- **`escalation`** `{lastGapDays:int, medianDays:number} | null` —
  informational flag set when the latest interval is at or under half the
  running median of the prior intervals (min 4 intervals). Not a separate
  model; recency weighting carries the estimate. Renders as a warning line,
  quiets automatically when cadence normalizes.
- **`dayOfWeek`** `[{day, percent}] | null` and **`weekOfMonth`**
  `[{week, percent}] | null` — `null` until the personal sample earns
  display: **35+ tests AND chi-square vs uniform significant at p<0.05**
  (df 6 crit 12.59 for days; same gate for weeks — five sparse bins lie as
  fluently as seven). Below the gate, most cells hold 0–2 observations and
  any coloring presents noise as signal. When null, render
  `dayOfWeekSuppressed` (human-readable reason with progress, e.g.
  "needs 35+ tests (15 so far)") plus `countyDayPattern` — never an empty
  or zeroed chart.
- **`countyDayCounts`** `[int x7] | null` — pooled county MUST_TEST counts
  Sun..Sat, for the weekday-frequency cells. Added 2026-08-26 so clients
  need no second fetch (the web dashboard's cells raced /api/system-stats
  and lost). Render per §4.11a: single-hue intensity, counts in ink colors,
  weekends low — never absent, never green.
- **`countyDayPattern`** `{total, weekendCount, fullWeekSignificant,
  weekdaySignificant} | null` — pooled county-level facts, two-stage tested.
  Production reality: the full-week chi-square clears (p<0.01) ENTIRELY on
  weekends (2 of 72 tests ever); the weekday-only test does not clear. Label
  as "Montgomery County overall", never as the user's own pattern, and
  phrase weekends as "rare, not never".
- **`notes`** `[string]` — user-presentable caveats. Clients show them
  verbatim; the server owns the epistemics.

**Past-range state — MANDATORY client rule (filed 2026-09-02).** When
`daysSinceLastTest` exceeds the upper edge of whatever band the client is
showing (`window.outerDays[1]` in `irregular`/`two_number`; the county range
in `insufficient` once it exists), the client MUST say so rather than go
quiet. In the 2026-09-02 backtest the app had nothing to say for 8, 1, 37 and
4 days on four of the six envelope misses — the moment of most anxiety. No
new field is needed; the sentence is true from fields already returned:

> 37 days since your last test. That's past your usual range — your gaps have
> run 9 to 26 days. Testing is possible any day. That hasn't changed.

Never "overdue", "missed" or "late": the server does not know whether anyone
attended (§4.5 attendance is on-device only), and silence must never read as a
missed test.

Zero-history shape: `testsCounted: 0`, all nullable fields `null`,
`recentTests: []`, one note explaining prediction unlocks after the first
required test.

Percentages are 0–100 floats. **The heat thresholds that previously lived
here (<12 green, 12–25 amber, ≥25 red) are deleted — see §4.11a.**

### 4.11 `GET /county-stats`

County-scoped aggregates. Discriminated on `type` so Swift can decode cleanly.

Montgomery — interval model:

```json
{
  "type": "montgomery",
  "montgomery": {
    "systemAvgIntervalDays": 21.5, "medianIntervalDays": 19,
    "usersWithTests": 12, "backToBackRate": 1.9,
    "totalMustTest": 41, "testsPerMonth": 9.2,
    "dayOfWeek": [], "weekOfMonth": []
  },
  "fortBend": null
}
```

**`weekOfMonth` is NOT CURRENTLY COMPUTED and always returns `[]`.** There is
no week-of-month aggregate behind it, and an empty array here means "not
available", not "no tests fell in any week". Clients should render nothing
rather than an empty chart. `dayOfWeek` is real: pooled Sun..Sat MUST_TEST
counts, rendered per §4.11a.

**`dueSoon` ratios need `averageIntervalDays` shown beside them.** A colour
announced 77 times genuinely has short gaps, so it produces a high
`overdueRatio` that is arithmetically true but reads more dramatic than it is.
The fix is presentational, not a hidden threshold: show "4.33× · normally
every 3 days". A second server-side gate would silently drop real colours;
`dueSoon` is gated only on 5+ appearances, which removes single-observation
noise and nothing else.

Fort Bend — rotation model:

```json
{
  "type": "ftbend",
  "montgomery": null,
  "fortBend": {
    "totalCallsLogged": 366,
    "mostCalled": [ {"name":"Gray","hex":"#9BA1A8","percent":15.9,"count":58,"isProgram":false} ],
    "dueSoon":   [ {"name":"Tan","hex":"#D9B98C","daysSince":73,"averageIntervalDays":10,"overdueRatio":7.3,"isProgram":false} ],
    "byDayOfWeek": [ {"day":"mon","name":"Bronze","hex":"#C1802F"} ],
    "yourColor": {"name":"Zinc","hex":"#A8AEB3","daysSince":31,"averageIntervalDays":18,"overdueRatio":1.72}
  }
}
```

**The server owns the hex values.** Colors are domain data, not styling — a new
county color must not require an app release. `isProgram: true` marks Prep /
Prep Phase 1 / Prep Phase 2, which render on a neutral slate swatch.

`overdueRatio = daysSince / averageIntervalDays`. Server computes it so both
clients sort identically.

### 4.11a Charting policy — binds every client

**Frequency charts** (day-of-week, week-of-month, color rotation) use a
**single-hue intensity ramp**: darker/more saturated = observed more often.
**Never a green/amber/red scale.** Green implies a safe day, and there is no
safe day — any day can be a test day. A user who plans around a green cell
and gets called was failed by the product; readiness, not safety, is the
message everywhere.

**Directional risk scales** (overdue ratio) are different: the ordering is
real — 0.3× genuinely is less likely today than 1.7× — so they keep a scale.
But the scale runs **neutral → alert**: dim/slate at low ratios, through
amber, to red as it passes 1.0. **Never green.** Low reads "not due yet" —
never "safe", "clear", or any wording that licenses skipping a morning check.

**Green is reserved for confirmed past-tense outcomes.** A NO_TEST that was
actually announced today is a fact about today and may be green. Nothing
that forecasts — a frequency, a ratio, a window — may be.

Concretely:
- One hue per frequency chart, intensity proportional to relative frequency
  (backend web uses `rgba(0,217,255, 0.12 + rel*0.68)`; iOS picks one hue and
  holds it).
- Low intensity reads "observed less often" — copy must never translate it
  as "unlikely", "safe", or "clear".
- Overdue-ratio displays ramp slate → amber → red with the alert boundary
  at 1.0 (the 1.0 tick stays). Low ratio = neutral, not green.
- Suppressed charts (see §4.10 gates) render the suppression reason and the
  county-level pattern — never an empty, zeroed, or greyed chart that still
  implies shape.
- Titles say "Frequency", not "Likelihood", for anything computed from raw
  counts.
- Legends state the semantics plainly, e.g. "Darker = called more often.
  No day is safe — any day can be a test day."

### 4.12 `POST /devices` · `DELETE /devices/{token}`

Push registration.

```json
{ "token": "apns-hex", "platform": "ios", "environment": "production",
  "appVersion": "1.0.0", "osVersion": "26.5" }
```

Unique on `token`, not `user_id` — one user, several devices. Registration
UPSERTS on the token and reassigns `user_id`, because a device can change
hands, and it clears any previous prune so a reinstalled app comes back to
life.

`environment` (`production` | `sandbox`) travels WITH the token and is
required: APNs sandbox and production are separate address spaces, and a token
minted against one is invalid on the other — get it wrong and TestFlight
builds silently receive nothing.

Server prunes on APNs `Unregistered` and `BadDeviceToken` receipts. Pruning is
a SOFT delete (`unregistered_at`), so "we stopped being able to reach this
person" stays auditable rather than vanishing.

`DELETE /devices/{token}` is scoped to the caller and idempotent: removing an
already-removed device returns `{"removed": 0}`, not a 404.

`GET /devices` returns the caller's own LIVE registrations, newest-seen first:

```json
{ "devices": [
  { "token": "apns-hex", "platform": "ios", "environment": "production",
    "appVersion": "1.0", "osVersion": "26.5",
    "createdAt": "2026-09-01T17:26:19Z", "lastSeenAt": "2026-09-02T08:04:11Z" }
] }
```

It returns the token VALUE, because `DELETE /devices/{token}` is keyed on it —
without it there is no way for someone to retire a phone they no longer have,
which is the point of the Account screen showing this list at all. Scoped to
the caller. An APNs token is only an address: sending to it still requires the
signing key, which never leaves the server.

Pruned devices are omitted. `lastSeenAt` is refreshed on every registration,
so it is how the client tells "this device" from an old one — and how a stale
registration becomes visible to the person who owns it.

### 4.12a `POST /push/{deliveryId}/ack`

→ `{ "acked": true, "fallbackCancelled": true }`

The app calls this when the user opens the notification. **This is what
cancels the SMS fallback**, so it is the difference between one notification
and two. `deliveryId` arrives in the push payload's custom data:

```json
{ "aps": { "alert": { "title": "Test required today", "body": "..." },
           "sound": "default", "interruption-level": "time-sensitive" },
  "deliveryId": "uuid", "result": "MUST_TEST", "date": "2026-09-02",
  "resultAvailable": true }
```

`resultAvailable: true` means `GET /today` will return this result right now.
The app should rewrite the widget snapshot on receipt rather than waiting on
the widget's own timeline budget. The alert body is county-specific (PIN
wording for Montgomery, "Today's color is Grey. Your color (Blue) was called."
for Fort Bend); the client may restyle it but should not need to.

`fallbackCancelled` is `false` when the ack lost the race and the SMS has
already gone out — the server reports what happened rather than claiming a
cancellation that did not occur.

### 4.13 `POST /checkout-link`

```json
{ "intent": "credits", "creditCount": 95 }
```
→ `{ "url": "https://...", "attributionId": "uuid", "priceCents": 4185 }`

**`priceCents` is computed server-side and is authoritative.** A
client-supplied price is never read. The tiers are 50¢ for the first 30
credits, 42¢ for the next 60, then 33¢ — so 95 credits is
(30 × 50) + (60 × 42) + (5 × 33) = **4185**, not the 3700 this example
claimed before 2026-08-27.

**Log the attribution ID on every tap from day one.** US external link-outs are
currently 0% commission, but the district court is setting a fee on remand. When
a number lands you'll need to know which purchases originated in-app, and you
cannot reconstruct that retroactively.

The app opens the URL in `SFSafariViewController`, then re-fetches `/me` on
return to refresh the balance.

### 4.13a `GET /pricing`

**Public — no auth.** Prices are printed on the landing page, and the paywall
needs them before sign-in.

```json
{
  "currency": "usd",
  "subscription": {
    "priceCents": 1499, "currency": "usd",
    "interval": "month", "intervalCount": 1,
    "creditsPerPeriod": 30,
    "asOf": "2026-09-02T18:40:11Z"
  },
  "credits": {
    "minimumCents": 500,
    "maxCredits": 1825,
    "tiers": [
      { "fromCredit": 1,  "toCredit": 30,   "centsPerCredit": 50 },
      { "fromCredit": 31, "toCredit": 90,   "centsPerCredit": 42 },
      { "fromCredit": 91, "toCredit": null, "centsPerCredit": 33 }
    ]
  }
}
```

**Never hardcode a price in the app again.** `subscription.priceCents` comes
from Stripe (the live recurring Price), cached server-side for ten minutes, so
a price change in the Stripe dashboard reaches the app without a release.
`credits.tiers` is the very array the server charges from — the app renders it
rather than mirroring the formula.

**Tier math, for display.** Tiers are marginal: credits 1–30 cost 50¢ each,
31–90 cost 42¢ each, 91+ cost 33¢ each, then apply `minimumCents` as a floor.
`toCredit: null` means no upper bound. 95 credits is
(30 × 50) + (60 × 42) + (5 × 33) = 4185. This is an estimate for the screen;
the charge is whatever `POST /checkout-link` returns in `priceCents`, and the
two are computed from the same tiers so they cannot disagree.

**`subscription` may be `null`.** That means no price has ever been fetched
(Stripe unreachable since boot, or the Price ID unset). Render the subscribe
option as unavailable — do NOT fall back to 1499. If Stripe is unreachable
after a successful fetch, the last good price is served and `asOf` says how old
it is. The response carries `Cache-Control: public, max-age=300`; refetch when
the paywall screen appears, not on every render.

`currency` is ISO 4217 lowercase. Everything is USD today; the field exists so
that is a fact the app reads rather than assumes.

### 4.14 `GET /referral` · `POST /referral/connect`

**`code` is never `null` (2026-09-02).** It is assigned when the profile is
created — in the database trigger, migration 046 — and backfilled for every
older account. The endpoint also assigns one on read if it somehow finds
none. Clients may decode it as required.

Example response — **the values are illustrative, not normative.** Read
every number from the live response; none of them is a constant you may
hardcode.

```json
{
  "code": "DAVE30", "signups": 14, "commissionRate": 0.20,
  "shareUrl": "https://www.probationcall.com/?ref=DAVE30",
  "programEnabled": false,
  "lifetimeEarnedCents": 31200, "availableCents": 12750,
  "balances": { "heldCents": 898, "availableCents": 12750, "paidCents": 17552,
                "minimumPayoutCents": 2000, "nextPayoutDate": "2026-10-01", "holdDays": 30 },
  "connect": { "state": "ready", "payoutsEnabled": true, "detailsSubmitted": true },
  "payouts": [ { "date": "2026-09-01", "amountCents": 17552, "status": "paid" } ]
}
```

**`programEnabled` gates every action.** While it is `false` the Earn tab
shows the code and the share link and nothing else — no balances copy that
promises money, no Set up payouts button. It stays `false` until the tax
picture is confirmed and onboarding has been tested end to end with a real
connected account.

**Money model: accrue, hold, pay — not split at checkout.** A commission is
`commissionRate` of a one-time bundle (subscriptions and the month pass pay
none). **The server is the only source of the rate: clients render the value
from `GET /referral` and never hardcode it**, so the rate can move without a
contract change or a client release. It is written as a ledger row the
moment the sale settles, **held for 30 days**,
then available, then paid on the **1st of each month** in ONE Stripe
transfer per affiliate, only when the available balance is at or above
**$20** and the connected account is payouts-enabled. `connect.state` is
`not_started` | `in_progress` | `pending_review` | `ready`.

Why not destination charges with `application_fee_amount`? They were the
elegant answer for reconciliation, and were rejected on refund safety: a
split at checkout requires a payouts-enabled account at the moment the
referred customer pays (most referrers have not onboarded when their first
referral buys, so a ledger path is needed anyway — two money paths, not
one), and a refund a week later reverses funds an Express account has
usually already paid out, driving it negative with the platform liable.
Holding the commission for 30 days makes a refund in that window a ledger
entry and nothing else. Disputes after payout still reverse the transfer.

**Tax paperwork.** Express is the Connect type where Stripe collects the
taxpayer number, matches it, files the forms and delivers them. **The
platform remains the payer of record and the forms carry its name; there is
no arrangement in which the obligation vanishes — destination charges
included.** The app never asks for, sees, or stores a taxpayer number.

**Tax research, 2026-09-03 — three rules a future change must not break:**
1. **Credits do not avoid 1099s.** The IRS deems payment when an amount is
   credited and usable, at fair market value; a referral reward is
   compensation whatever the medium. Connect stays.
2. **The 30-day hold is a tax control, not only refund safety.** A held
   commission is "restricted" — not yet income — until the clawback window
   closes, which keeps Year-1 / Year-2 reporting clean. Do not shorten it
   without understanding that.
3. **Never pay anyone outside Connect, ever.** A payee who refuses a TIN
   triggers 24% backup withholding; paying without it makes that 24% the
   platform's liability, and withholding forces a 1099 even below the
   threshold. Express collects the TIN at onboarding; no manual payouts, no
   exceptions.

The federal 1099-NEC threshold for 2026 payments is **$2,000**. **Open
item:** some states may still be $600 (Mississippi, Wisconsin and
Massachusetts flagged), and filing follows the affiliate's address, not the
platform's. The tax-forms setting in Stripe stays off until the accountant
confirms in writing.

**`POST /referral/connect`** → `{ "url": "https://connect.stripe.com/…" }`.
Creates the Express account on first call, then mints an onboarding link
(fresh each time — links expire, and an abandoned onboarding simply resumes
where it stopped). Open it in an in-app browser sheet; Stripe returns to
`{BASE_URL}/dashboard?connect=success` or `…?connect=refresh`, which the
sheet should treat as "done, re-fetch `/referral`". Refused with
`403 forbidden` while `programEnabled` is `false`.

**`POST /referral/apply`** `{ "code": "DAVE30" }` →
`{ "applied": true, "code": "DAVE30", "bonusCredits": 0 }`. The app's
attribution path (2026-09-02): the app captures `ref` from the share link
(universal link or clipboard) at signup and submits it here, so someone who
taps a link, installs the app and signs up in it is attributed exactly like a
web signup.

Rules: one code per account, ever; not your own (`400`); unknown code `404`.

**A code may be applied at any time until the account's first successful
purchase, and is refused after it** (`409 referral_after_purchase`). There is
no time limit — a code applied months after signup is valid, because a
referral is an acquisition claim and an account that has never paid has not
yet been acquired. An account that has already paid was not acquired by
anyone, so the claim is refused. Any purchase counts, including a
subscription, the month pass, and a purchase later refunded. Free starter
credits are not a purchase.

**Retrying is safe.** Submitting the *same* code again returns `200` with
`applied: true` — the call is idempotent, so an app that retries a request
whose response it never saw is not told its own success was an error.
`bonusCredits` counts only what THIS call granted and is `0` on a repeat;
clients must not add it to a balance twice. Submitting a *different* code
once one is applied is `409 referral_already_applied`. Those two 409s are
distinct conditions and clients branch on `code`, never on the status.

**Attribution is recorded whether or not `programEnabled` is true** — links
circulate while the program is off — but the referred-signup bonus
(`bonusCredits`, 5 today) is granted only while it is on, so a code cannot be
used to farm credits from an inactive program.

### 4.15 `DELETE /account`

App Store guideline 5.1.1(v) — hard requirement, not optional. Shipped
2026-09-02. Body must be `{"confirm": "DELETE"}` → `{ "deleted": true }`.
Rate-limited (5 per hour). The client signs out on success; the next request
on the old token is rejected by the auth server regardless (v1 auth validates
every token server-side, never by local decode — `test/auth.test.js` pins it).

**Billing first, rows second.** An active Stripe subscription is cancelled
immediately (no proration) and the Stripe customer is removed BEFORE any row
is touched. If Stripe refuses, **nothing is deleted** and the response is
`502 billing_cancel_failed` (retryable): a half-deleted account with live
billing is worse than no endpoint. Stripe retains charges and invoices under
its own policy.

**Refused with `409 unpaid_affiliate_earnings`** when the caller is an
affiliate with earnings not yet paid or a payout request pending. The message
says to request a payout or contact support first. Money we owe cannot be
deleted away.

**What is deleted:** schedule, call history, call attempts, missed-call
events, credit ledger, checkout attributions, notification log, support
messages, promo redemptions, mass-send membership, referral records they
created, their affiliate earnings and payout requests, device tokens, push
deliveries, every pending queue row, the profile, the auth user, and their
Twilio call recordings.

**What is kept, by ruling (2026-09-02):**
- `sms_opt_outs` — untouched, keyed by phone. A number that replied STOP
  stays stopped even if it registers again.
- `sms_consents` — `user_id` nulled; phone and timestamp stay as TCPA
  evidence.
- `purchases` — `user_id` nulled; Stripe ids and amounts stay for chargeback
  defence.
- `affiliate_earnings` / `referrals` where the deleted person was the
  REFERRED party — reference nulled; it is someone else's money.

**Re-signup does not restart the free credits.** A SHA-256 of the normalised
email is stored on deletion (`deleted_account_tombstones`, migration 042).
A later signup with the same address gets a profile with zero starter
credits. The address itself is not retained.

**Partial failure:** billing is settled before anything else, so a failure
after that point never leaves live billing behind. Row-level failures are
logged for operator cleanup and the profile delete cascades most of them
anyway. If the **profile row itself** cannot be deleted (a NO ACTION
reference the endpoint missed), the auth user is NOT deleted — that would
orphan a profile holding the email — and the response is
`409 account_deletion_blocked` (not retryable): billing is closed, admins
are alerted, support finishes it. If the auth delete fails after the profile
is gone, `500 internal` (retryable) — every step is idempotent.

---

### 4.17 `POST /phone/verify/start` · `POST /phone/verify/check`

Server-side phone verification (2026-09-02). The app used to generate a code
locally and show it only in a Debug chip, so on TestFlight no SMS was sent
and nobody could sign up.

```json
POST /phone/verify/start   { "phone": "(281) 555-0142", "smsConsent": true }
→ { "sent": true, "phoneLast4": "0142", "expiresInSeconds": 600, "resendAfterSeconds": 60 }

POST /phone/verify/check   { "phone": "(281) 555-0142", "code": "483920" }
→ { "verified": true, "phoneLast4": "0142", "verifiedAt": "2026-09-02T20:41:07Z" }
```

**The code never appears in any response.** It is texted, stored only as an
HMAC under a server secret (`PHONE_VERIFY_SECRET`, Railway), expires in ten
minutes, and dies after five wrong attempts. A new `start` for the same
number retires the previous code, so at most one is live.

**Numbers are US/Canada only** (`+1`), which is what makes international SMS
pumping impossible. A number that has replied STOP is refused with
`409 sms_opted_out` — the person must text START first.

**Consent binds here exactly as on `PUT /schedule`:** `smsConsent: true`
records consent (source `phone_verify`); an existing record satisfies;
neither is a `400`. This is a text to a number we are about to text daily.

**Limits, counted from durable rows, not memory:** 60 seconds between
resends to the same number; 3 sends per 10 minutes and 6 per day per account;
the same per phone number across ALL accounts; 100 per day service-wide
with an admin alert at 50. Over a limit is `429 rate_limited` with
`Retry-After`. The message says whether it is the resend wait or a cap.

**`check` outcomes,** all `400` with a stable code the client branches on:
`verification_not_found` (nothing waiting — request a new code),
`verification_expired`, `verification_locked` (five wrong attempts — request
a new code), `verification_incorrect` (message says attempts left). On
success `profiles.verified_phone` is set and `/me` reports it under
`phone`. A later change of number requires verifying again.

**What it gates:** SMS on `PUT /schedule` (§4.7). Email-only schedules need
no verification. Twilio Verify was considered and skipped: `+1` only plus
the daily cap and alert bound the worst day at under a dollar; it is a
one-day swap if abuse ever appears.

### 4.16 App Review demo account (server behaviour, not an endpoint)

App Store review needs working credentials and a populated dashboard, and it
cannot be a real subscriber's data. `profiles.is_demo` (migration 043) marks
one Montgomery account (PIN `000000` — outside every observed PIN shape, and
`initiateCall` refuses to dial that value at all) whose
morning cron **writes a synthetic result instead of dialling** — required
tests on a fixed 12–15 day cycle, two UNKNOWN mornings a month, no recording,
no SMS/email/push, no credit movement — so the history stays current however
long review takes and Predict shows `two_number`. The account is excluded
from every pooled statistic (county range, county stats, funnel). Test-send
and manual-call endpoints return `{ success: true, demo: true }` for it
without sending. Seeded by `scripts/seed-demo-account.js` (env
`DEMO_ACCOUNT_EMAIL`, password supplied at run time); credentials go in App
Store Connect review notes, never in either repo. Clients need no special
handling: the demo account looks like any other user.

### 4.18 `GET /offices`

**Public — no auth.** The county office directory: where the offices are,
when they are open, and what the county says about testing at them. The app
may want it before sign-in, and there is nothing account-specific in it.

**This is public facility information, not location data.** These are the
addresses of county probation offices, published by the county on its own
client instruction forms. The system still holds no location data about any
user: it does not know, ask, store, or infer where a person is, and §4.2's
rule is unchanged — a history row names a county or an office, never a city.
The direction of the fact is what matters. This endpoint tells the user where
the county's building is. Nothing anywhere tells us where the user is.

It exists because the directory used to be hardcoded in the app, so
correcting a set of hours needed an App Store release and never reached
anyone on an older build. The failure that prevents: hours change, the app
confidently shows the old ones, and someone drives to a closed office and
misses a test.

```json
{
  "counties": {
    "montgomery": {
      "hasDirectory": true,
      "timeZone": "America/Chicago",
      "assignmentRule": "Test only at the office you're assigned to. Check with your officer if you're not sure.",
      "mapsQuery": "Montgomery County Community Supervision and Corrections Department, Conroe, TX",
      "offices": [
        { "id": "conroe", "name": "RMS Conroe Office",
          "street": "310 East Davis Street, Suite 100", "cityLine": "Conroe, TX 77301",
          "phone": "(936) 207-4223",
          "hours": { "monday": ["08:00-17:45"], "saturday": ["08:00-15:00"] },
          "notes": ["Saturday: Conroe only, and only if you're required to test that day."] }
      ]
    },
    "ftbend": {
      "hasDirectory": false,
      "timeZone": "America/Chicago",
      "assignmentRule": null,
      "mapsQuery": "Fort Bend County Community Supervision and Corrections Department, Missouri City, TX",
      "offices": []
    }
  },
  "asOf": "2026-09-03T20:12:20.621Z"
}
```

The example is trimmed for length — the live Montgomery payload carries both
offices and all their open days. Values are illustrative; read every one from
the response.

**`hours` is a weekday map of open spans, and a MISSING WEEKDAY MEANS CLOSED
THAT DAY.** Keys are lowercase English weekday names, values arrays of
`"HH:mm-HH:mm"` in 24-hour local time. **Two spans on one day is a closure in
between** — a lunch break. A closed day is expressed by absence and never by
an empty array, so a client must not read a missing key as "hours unknown".
Hours are local to the office, in the county's `timeZone`, never the device's.

**`hasDirectory` is the whole safety model, and it is derived from whether
the county actually has verified offices — never from a flag.** When it is
`true`, the app may show the address and offer directions to that pin. When
it is `false` there are no verified addresses, and the app **must not** invent
one: fall back to a Maps *search* rather than a pinned location, because a
wrong address sends someone on probation to the wrong building. Fort Bend is
`false` today, on purpose, until its client instruction form arrives and
someone verifies its three offices.

**`mapsQuery` is the fallback-of-the-fallback.** It is one search string per
county, for a client that has no better idea. A client that already knows a
finer-grained search for the specific office the user is assigned to should
prefer its own — Fort Bend's three offices are in two different cities, and a
single county-level string cannot express that. Once a county has real office
rows, `hasDirectory` is `true` and `mapsQuery` stops being consulted at all.
May be `null`.

**`assignmentRule`** is the county's own rule about which office a person may
test at, shown above the list. May be `null`. The app never picks an office
for anyone.

**`asOf` is when this data was last edited**, the newest change across the
counties and offices returned. **Clients MUST show the `asOf` date whenever
the directory they are displaying is more than 7 days old.** This is a MUST,
not a SHOULD, and it is not a client's decision to skip. Office hours are the
one thing in this app where a confidently wrong answer sends someone to a
closed building and into a violation, so past a week the user is told how old
the information is and can call the office instead of trusting the screen.

**Caching.** `Cache-Control: public, max-age=86400` — the data changes a few
times a year. Cache the last good response on device, like `/today`, so the
chooser works on a dead connection.

**On failure this returns `500`, never an empty directory.** An empty payload
is not "no data": it decodes as `hasDirectory: false` for every county, which
reads as "no verified addresses exist anywhere" — a confident wrong answer
produced by a database hiccup. A `500` means the client keeps its last good
cached copy, which is the honest degradation. A client must not treat an
error as an empty directory either.

**Retired offices simply disappear.** An office withdrawn from the directory
stops being returned; the row is kept server-side so the record it existed
survives. A client holding a cached office that is no longer listed should
drop it.

## 5. Build order

1. **`prediction-core.js`** — extract from `dashboard.html`, unit test it.
   Blocks 4.10 and 4.11. Already half-done in the working tree.
2. **JWT middleware** + `GET /me`, `GET /today` — the app can render real data.
3. **`GET /history`, `/calls/{id}`, `/calls/{id}/recording`** — History tab.
4. **`PUT /schedule`, pause/resume, `/test/*`** — onboarding + Account.
5. **`/prediction`, `/county-stats`** — analytics screens go live. Point the web
   dashboard at these too and delete the client-side copy.
6. **`/devices`** — then the push send path.
7. **`/checkout-link`, `/referral`, `DELETE /account`** — submission requirements.

Steps 1–2 turn the app from a mockup into a product. Everything after is filling in.

## 6. iOS side

- Reshape `MockData` to match these payloads exactly so the swap is one file.
- One `APIClient` with the bearer token from the Supabase session, a single retry
  on `401` after refresh, and typed errors off `error.code`.
- Decode every enum with an `unknown(String)` fallback. No exceptions.
- Cache the last `/today` response so the app opens to something on a dead
  connection at 5 AM, clearly marked stale.
- Cache the last `/offices` response the same way, so the office chooser works
  offline — and show its `asOf` date once that cache is over 7 days old
  (§4.18, a MUST).
