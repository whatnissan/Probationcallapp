require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const path = require('path');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const pendingCalls = new Map();
const callLogs = new Map();
const wsClients = new Set();

let scheduledJobs = new Map();
let savedScheduleConfig = null;

const KEYWORDS = {
  NO_TEST: ['do not test', 'not required', 'no need', 'you do not', 'do not need', 'not test'],
  MUST_TEST: ['required to test', 'must test', 'you are required', 'report for', 'required today']
};

function log(callId, message, type = 'info') {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, message, type };
  if (callId) {
    if (!callLogs.has(callId)) callLogs.set(callId, []);
    callLogs.get(callId).push(entry);
  }
  const icons = { info: '📋', success: '✅', warning: '⚠️', error: '❌' };
  console.log(`${icons[type] || '📋'} [${callId || 'SYSTEM'}] ${message}`);
  broadcastToClients({ type: 'log', callId, log: entry });
}

function broadcastToClients(data) {
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', baseUrl: process.env.BASE_URL, twilioNumber: process.env.TWILIO_PHONE_NUMBER }));
app.get('/api/logs/:callId', (req, res) => res.json({ logs: callLogs.get(req.params.callId) || [] }));

async function initiateCall(targetNumber, pin, notifyNumber) {
  const callId = `call_${Date.now()}`;
  const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
  const baseUrl = process.env.BASE_URL;

  log(callId, '════════════════════════════════════════', 'info');
  log(callId, `NEW CALL - Target: ${targetNumber}, PIN: ${pin}`, 'info');
  log(callId, `Notify: ${notifyNumber}, From: ${twilioNumber}`, 'info');

  pendingCalls.set(callId, { targetNumber, pin, notifyNumber, transcript: [], result: null, startTime: new Date() });

  const call = await twilioClient.calls.create({
    to: targetNumber,
    from: twilioNumber,
    url: `${baseUrl}/twiml/answer?callId=${callId}`,
    statusCallback: `${baseUrl}/webhook/status?callId=${callId}`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    statusCallbackMethod: 'POST',
    timeout: 60
  });

  pendingCalls.get(callId).callSid = call.sid;
  log(callId, `Call created! SID: ${call.sid}`, 'success');
  return { success: true, callId, callSid: call.sid };
}

app.post('/api/call', async (req, res) => {
  try {
    const { targetNumber, pin, notifyNumber } = req.body;
    if (!targetNumber || !pin || !notifyNumber) return res.status(400).json({ error: 'Missing fields' });
    if (!/^\+\d{10,15}$/.test(targetNumber) || !/^\+\d{10,15}$/.test(notifyNumber)) return res.status(400).json({ error: 'Use E.164 format: +15551234567' });
    if (pin.length !== 6 || !/^\d+$/.test(pin)) return res.status(400).json({ error: 'PIN must be 6 digits' });
    res.json(await initiateCall(targetNumber, pin, notifyNumber));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/call-auto', (req, res) => app.handle(Object.assign(req, { url: '/api/call' }), res));

app.post('/twiml/answer', (req, res) => {
  const { callId } = req.query;
  const config = pendingCalls.get(callId);
  const baseUrl = process.env.BASE_URL;

  log(callId, 'Call connected! Sending DTMF...', 'success');
  const twiml = new twilio.twiml.VoiceResponse();

  if (!config) {
    log(callId, 'ERROR: No config found', 'error');
    twiml.say('Error');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Timing from video: 5s wait, press 1, 10s wait, PIN, 10s wait, press 1
  const seq = 'wwwwwwwwww' + '1' + 'wwwwwwwwwwwwwwwwwwww' + config.pin + 'wwwwwwwwwwwwwwwwwwww' + '1';
  log(callId, `DTMF: 5s-1-10s-${config.pin}-10s-1`, 'info');

  twiml.play({ digits: seq });
  twiml.pause({ length: 2 });

  twiml.gather({
    input: 'speech',
    timeout: 15,
    speechTimeout: 3,
    action: `${baseUrl}/twiml/result?callId=${callId}`,
    method: 'POST',
    hints: 'do not test today, do not test, required to test, you are required, must test'
  });

  twiml.redirect(`${baseUrl}/twiml/fallback?callId=${callId}`);
  log(callId, 'TwiML sent, listening for result...', 'info');
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/result', async (req, res) => {
  const { callId } = req.query;
  const speech = req.body.SpeechResult || '';
  const config = pendingCalls.get(callId);

  log(callId, `SPEECH: "${speech}"`, 'info');
  const twiml = new twilio.twiml.VoiceResponse();

  if (config) {
    config.transcript.push({ text: speech });
    const lower = speech.toLowerCase();

    if (KEYWORDS.MUST_TEST.some(k => lower.includes(k))) {
      config.result = 'MUST_TEST';
      log(callId, '🚨 RESULT: TESTING REQUIRED!', 'warning');
      await notify(config.notifyNumber, `🚨 TEST REQUIRED! PIN: ${config.pin} - ${ts()}`, callId);
    } else if (KEYWORDS.NO_TEST.some(k => lower.includes(k))) {
      config.result = 'NO_TEST';
      log(callId, '✅ RESULT: No test today!', 'success');
      await notify(config.notifyNumber, `✅ No test today. PIN: ${config.pin} - ${ts()}`, callId);
    } else {
      config.result = 'UNKNOWN';
      log(callId, `⚠️ UNKNOWN: "${speech}"`, 'warning');
      await notify(config.notifyNumber, `⚠️ Call done. Heard: "${speech.slice(0,80)}". Verify manually.`, callId);
    }
    broadcastToClients({ type: 'result', callId, result: config.result, speech });
  }

  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/fallback', async (req, res) => {
  const { callId } = req.query;
  const config = pendingCalls.get(callId);
  log(callId, 'Fallback: no speech detected', 'warning');

  if (config && !config.result) {
    config.result = 'UNKNOWN';
    await notify(config.notifyNumber, `⚠️ Call done but no result detected. Verify manually. PIN: ${config.pin}`, callId);
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

app.post('/webhook/status', (req, res) => {
  const { callId } = req.query;
  const { CallStatus, CallDuration } = req.body;
  log(callId, `STATUS: ${CallStatus} | Duration: ${CallDuration || 0}s`, 'info');

  const config = pendingCalls.get(callId);
  if (config) {
    config.status = CallStatus;
    config.duration = CallDuration;
    broadcastToClients({ type: 'status', callId, status: CallStatus, result: config.result });
  }
  res.sendStatus(200);
});

app.get('/api/call/:callId', (req, res) => {
  const c = pendingCalls.get(req.params.callId);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json({ callId: req.params.callId, result: c.result, status: c.status, duration: c.duration, transcript: c.transcript, logs: callLogs.get(req.params.callId) || [] });
});

// Scheduling
app.get('/api/schedule', (req, res) => res.json({ hasSchedule: !!savedScheduleConfig, schedule: savedScheduleConfig }));

app.post('/api/schedule', (req, res) => {
  try {
    const { targetNumber, pin, notifyNumber, hour, minute, timezone, enabled } = req.body;
    scheduledJobs.forEach(j => j.stop());
    scheduledJobs.clear();

    savedScheduleConfig = {
      targetNumber, pin, notifyNumber,
      hour: parseInt(hour) || 6,
      minute: parseInt(minute) || 0,
      timezone: timezone || 'America/Chicago',
      enabled: enabled !== false
    };

    if (savedScheduleConfig.enabled) {
      const expr = `${savedScheduleConfig.minute} ${savedScheduleConfig.hour} * * *`;
      log('SCHED', `Creating: ${expr} (${savedScheduleConfig.timezone})`, 'info');

      const job = cron.schedule(expr, async () => {
        log('SCHED', `⏰ Triggered at ${new Date().toISOString()}`, 'info');
        try {
          await initiateCall(savedScheduleConfig.targetNumber, savedScheduleConfig.pin, savedScheduleConfig.notifyNumber);
        } catch (e) {
          log('SCHED', `FAILED: ${e.message}`, 'error');
          await notify(savedScheduleConfig.notifyNumber, `❌ Scheduled call FAILED. Call manually!`, 'sched');
        }
      }, { timezone: savedScheduleConfig.timezone });

      scheduledJobs.set('daily', job);
    }
    res.json({ success: true, schedule: savedScheduleConfig });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/schedule', (req, res) => {
  scheduledJobs.forEach(j => j.stop());
  scheduledJobs.clear();
  savedScheduleConfig = null;
  res.json({ success: true });
});

// Notifications via WhatsApp sandbox
async function notify(to, body, callId) {
  const from = 'whatsapp:+14155238886';
  const toWA = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  log(callId, `📱 Sending WhatsApp to ${toWA}...`, 'info');
  try {
    const msg = await twilioClient.messages.create({ from, to: toWA, body });
    log(callId, `📱 Sent! SID: ${msg.sid}`, 'success');
    return msg;
  } catch (e) {
    log(callId, `📱 FAILED: ${e.message}`, 'error');
    return null;
  }
}

function ts() { return new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }); }

app.post('/api/test-sms', async (req, res) => {
  try {
    const { notifyNumber } = req.body;
    if (!notifyNumber || !/^\+\d{10,15}$/.test(notifyNumber)) return res.status(400).json({ error: 'Invalid number' });
    const id = `test_${Date.now()}`;
    await notify(notifyNumber, `✅ Test from Probation Call App - ${ts()}`, id);
    res.json({ success: true, logs: callLogs.get(id) || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

wss.on('connection', (ws, req) => {
  if (req.url === '/ws') {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Probation Call App running on port ${PORT}`);
  console.log(`📍 Base URL: ${process.env.BASE_URL || 'NOT SET'}`);
  console.log(`📞 Twilio #: ${process.env.TWILIO_PHONE_NUMBER || 'NOT SET'}\n`);
});

module.exports = app;
