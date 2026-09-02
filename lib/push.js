// Who owns the SMS for a push_deliveries row. Extracted so it can be tested:
// the 2026-09-02 morning sent every Montgomery user their result twice,
// because the no-device and send-failed branches returned false (so the
// caller texted immediately) AND left the row due for the fallback sweep
// (which texted again a minute later). Exactly ONE party may deliver.
//
//   sent         — Apple accepted: the SWEEP owns delivery, due in N minutes
//                  unless acked. fallback_sent_at stays null.
//   no_device    — nothing to push to: the CALLER delivers now. The row is
//                  marked fallback_sent_at immediately so the sweep never
//                  picks it up. The reason is kept for the audit trail.
//   send_failed  — every device rejected: same as no_device.
function fallbackFieldsFor(outcome, nowMs, fallbackMinutes) {
  var now = new Date(nowMs).toISOString();
  if (outcome === 'sent') {
    return { fallback_due_at: new Date(nowMs + fallbackMinutes * 60000).toISOString(), fallback_sent_at: null, fallback_reason: null };
  }
  if (outcome === 'no_device' || outcome === 'send_failed') {
    return { fallback_due_at: now, fallback_sent_at: now, fallback_reason: outcome };
  }
  throw new Error('unknown push outcome: ' + outcome);
}

module.exports = { fallbackFieldsFor: fallbackFieldsFor };
