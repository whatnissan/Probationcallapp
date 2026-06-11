// Serializers between the in-memory pendingCalls config object and the
// pending_calls DB row (migration 013). Pure functions, kept here so the
// field mapping is round-trip unit-tested (test/pending.test.js) — a
// mismatched column name would otherwise only surface as a silently
// dropped field during a real mid-call restart.

function pendingCallToRow(callId, c) {
  return {
    call_id: callId,
    call_sid: c.callSid || null,
    user_id: c.userId || null,
    county: c.county || null,
    is_ftbend_daily: !!c.isFtbendDaily,
    office_id: c.officeId || null,
    has_phases: !!c.hasPhases,
    is_scheduled_morning: !!c.isScheduledMorning,
    pin: c.pin || null,
    target_number: c.targetNumber || null,
    notify_number: c.notifyNumber || null,
    notify_email: c.notifyEmail || null,
    notify_method: c.notifyMethod || null,
    retry_count: c.retryCount || 0,
    transcribe_retry: c.transcribeRetry || 0
  };
}

function rowToPendingCall(row) {
  return {
    callSid: row.call_sid || undefined,
    userId: row.user_id || undefined,
    county: row.county || undefined,
    isFtbendDaily: !!row.is_ftbend_daily,
    officeId: row.office_id || undefined,
    hasPhases: !!row.has_phases,
    isScheduledMorning: !!row.is_scheduled_morning,
    pin: row.pin || undefined,
    targetNumber: row.target_number || undefined,
    notifyNumber: row.notify_number || undefined,
    notifyEmail: row.notify_email || undefined,
    notifyMethod: row.notify_method || undefined,
    retryCount: row.retry_count || 0,
    transcribeRetry: row.transcribe_retry || 0,
    result: null,
    phase1: null,
    phase2: null,
    recoveredFromDb: true
  };
}

module.exports = { pendingCallToRow: pendingCallToRow, rowToPendingCall: rowToPendingCall };
