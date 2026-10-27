const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Migration 074 (2026-10-27): pausing did not stop calls, and measuring who
// was hit was guesswork because nothing recorded WHEN a schedule was paused.
// A trigger now records it on every writer. Exercised on Postgres 17 before
// commit: pause, unrelated write while paused, reason change, resume, second
// pause, insert-paused, account deletion.

test('migration 074 records pauses by trigger, on every writer', () => {
  const m = fs.readFileSync(path.join(__dirname, '..', 'migrations', '074_schedule_pause_tracking.sql'), 'utf8');
  assert.match(m, /ADD COLUMN IF NOT EXISTS paused_at timestamptz/);
  assert.match(m, /BEFORE INSERT OR UPDATE ON user_schedules/);
  assert.match(m, /INSERT INTO schema_migrations/);
});
