// Generate the Supabase "Apple client secret" — an ES256 JWT signed with the
// Sign in with Apple .p8 key.
//
// Usage:  node scripts/generate-apple-secret.js [path-to-AuthKey.p8]
//         (default path below; the key is NEVER in the repo — *.p8 is
//          gitignored and lives in ~/Documents/probationcall-keys/)
//
// The secret is written to supabase-apple-secret.txt NEXT TO THE KEY FILE —
// deliberately not printed to stdout, so it never lands in terminal
// scrollback or session logs. Paste its contents into Supabase Dashboard →
// Auth → Providers → Apple → Secret Key, then set APPLE_SECRET_EXPIRES in
// Railway to the expiry date this script prints.
//
// ROTATION: Apple caps the secret's lifetime at 6 months (15777000s). This
// script uses 180 days. Re-run it, re-paste, and update
// APPLE_SECRET_EXPIRES twice a year — the [APPLE-SECRET-CHECK] boot/daily
// warning in server.js exists precisely because forgetting this kills Apple
// sign-in silently.
//
// These are identifiers, not secrets (the Key ID ships in every JWT header):
const TEAM_ID = '232HWV6L3Y';
const KEY_ID = '42J4U7A8NA';
const SERVICES_ID = 'com.probationcall.signin'; // web client_id (sub claim)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const keyPath = process.argv[2] ||
  path.join(os.homedir(), 'Documents', 'probationcall-keys', 'AuthKey_' + KEY_ID + '.p8');

if (!fs.existsSync(keyPath)) {
  console.error('Key not found at ' + keyPath);
  process.exit(1);
}
const privateKey = fs.readFileSync(keyPath, 'utf8');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const now = Math.floor(Date.now() / 1000);
const expiresInDays = 180; // Apple max is ~182.6 days
const exp = now + expiresInDays * 86400;

const header = b64url(JSON.stringify({ alg: 'ES256', kid: KEY_ID }));
const payload = b64url(JSON.stringify({
  iss: TEAM_ID,
  iat: now,
  exp: exp,
  aud: 'https://appleid.apple.com',
  sub: SERVICES_ID
}));
const signingInput = header + '.' + payload;

// ES256 in JWS = ECDSA P-256 / SHA-256 with the raw r||s (IEEE P1363)
// signature encoding, not DER.
const signature = crypto.sign('sha256', Buffer.from(signingInput), {
  key: privateKey,
  dsaEncoding: 'ieee-p1363'
});
const jwt = signingInput + '.' + b64url(signature);

// Self-verify before writing anything.
const pub = crypto.createPublicKey(privateKey);
const ok = crypto.verify('sha256', Buffer.from(signingInput), { key: pub, dsaEncoding: 'ieee-p1363' }, signature);
if (!ok) {
  console.error('Self-verification FAILED — secret not written.');
  process.exit(1);
}

const outPath = path.join(path.dirname(keyPath), 'supabase-apple-secret.txt');
fs.writeFileSync(outPath, jwt + '\n', { mode: 0o600 });

const expIso = new Date(exp * 1000).toISOString().slice(0, 10);
console.log('Apple client secret generated and self-verified.');
console.log('  claims: iss=' + TEAM_ID + ' sub=' + SERVICES_ID + ' kid=' + KEY_ID);
console.log('  expires: ' + expIso + ' (' + expiresInDays + ' days)');
console.log('  written to: ' + outPath + ' (mode 600 — not printed here on purpose)');
console.log('');
console.log('NEXT STEPS (manual):');
console.log('  1. Supabase Dashboard -> Auth -> Providers -> Apple:');
console.log('       Client IDs: ' + SERVICES_ID + ',com.probationcall.app');
console.log('       Secret Key: paste contents of the file above');
console.log('  2. Railway env: APPLE_SECRET_EXPIRES=' + expIso);
console.log('  3. Delete supabase-apple-secret.txt after pasting.');
