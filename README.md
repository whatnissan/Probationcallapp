# ProbationCall

[probationcall.com](https://probationcall.com) — automates daily probation drug-test hotline check-ins. Each morning the system calls county hotlines, navigates the IVR with DTMF tones, transcribes the announcement, detects the result (color / phase group / PIN-called), and notifies subscribers by SMS and email.

## Counties

- **Montgomery County** — PIN-based IVR; per-user scheduled calls with auto-retry until a confident result or the 2:00 PM local cutoff.
- **Fort Bend County** — three offices (Missouri City, Rosenberg, Rosenberg 2). One system call per office at 5:05 AM CT, cross-checked against finishprobation.com, retried until 9:30 AM CT. Rosenberg 2 announces both colors and phase groups.

## Stack

| Concern | Tech |
|---|---|
| Runtime | Node.js 20 / Express 4 — entry point `server.js` |
| Database + auth | Supabase (service key server-side; anon key in browser for auth only) |
| Voice + SMS | Twilio (outbound caller +1 877 884 7310) |
| Transcription | Deepgram `nova-2`, post-call from the recording |
| Email | Brevo HTTP API (Railway blocks SMTP — do **not** use nodemailer) |
| Payments | Stripe, LIVE mode — credit bundles + $14.99/mo subscription |
| Hosting | Railway — **auto-deploys on push to `main`** |

## Development

```bash
npm install
cp .env.example .env   # fill in keys (names only are documented there)
npm start
```

There is no staging environment: **pushing to `main` deploys to production immediately.** Commit locally; the owner pushes.

- Project context, golden rules, and workflow: see [`CLAUDE.md`](CLAUDE.md)
- Repo audits: [`FULL_AUDIT_2026-06-11.md`](FULL_AUDIT_2026-06-11.md) (current), `AUDIT.md` / `AFFILIATE_AUDIT.md` (earlier; several findings since fixed)
- Database migrations: `migrations/` — additive SQL, run manually in the Supabase SQL editor in order

## Key behaviors worth knowing

- Credits are deducted only on a confirmed MUST_TEST / NO_TEST result — never for UNKNOWN, failed calls, or retries. All grants go through the `add_credits_with_ledger` RPC.
- An empty hotline transcript is treated as an outage signal: retries + admin alerting are load-bearing, don't remove them.
- Speech misrecognition mappings (`FTBEND_MISRECOGNITIONS`) require ongoing maintenance — add entries, don't delete.
- Detection refuses to guess: anything not on the known color/phase list reports UNKNOWN rather than a wrong answer.
