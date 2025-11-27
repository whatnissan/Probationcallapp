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

const activeCalls = new Map();
const pendingCalls = new Map();
const callLogs = new Map();

let scheduledJobs = new Map();
let savedScheduleConfig = null;

const wsClients = new Set();

function broadcastToClients(data) {
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function logToConsole(callId, message, type = 'info') {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, callId, message, type };

  if (callId) {
    if (!callLogs.has(callId)) {
      callLogs.set(callId, []);
    }
    callLogs.get(callId).push(entry);
  }

  const prefix = {
    info: '📋',
    success: '✅',
    warning: '⚠️',
    error: '❌'
  }[type] || '📋';

  console.log(`${prefix} [${callId || 'system'}] ${message}`);

  if (callId) {
    broadcastToClients({ type: 'log', callId, log: entry });
  }
}

const KEYWORDS = {
  NO_TEST: ['do not test', 'not required', 'no need to test', 'you do not', 'do not need'],
  MUST_TEST: ['required to test', 'must test', 'you are required', 'report for testing']
};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/logs/:callId', (req, res) => {
  res.json({
    callId: req.params.callId,
    logs: callLogs.get(req.params.callId) || []
  });
});

async function initiateCall(targetNumber, pin, notifyNumber, fromNumber) {
  const callId = `call_${Date.now()}`;
  const twilioNumber = fromNumber || process.env.TWILIO_PHONE_NUMBER;
  const baseUrl = process.env.BASE_URL;

  const log = (msg, type) => logToConsole(callId, msg, type);

  log('========================================', 'info');
  log(`Initiating call to ${targetNumber}`, 'info');
  log(`PIN: ${pin}, Notify: ${notifyNumber}`, 'info');
  log(`Using Twilio number: ${twilioNumber}`, 'info');
  log(`Base URL: ${baseUrl}`, 'info');

  pendingCalls.set(callId, {
    targetNumber,
    pin,
    notifyNumber,
    transcript: [],
    result: null,
    startTime: new Date()
  });

  const waitForGreeting = 'wwwwwwwwww';
  const waitForPinPrompt = 'wwwwwwwwwwwwwwwwwwwwwwww';
  const waitForLastName = 'wwwwwwwwwwwwwwww';
  const sendDigitsSequence = waitForGreeting + '1' + waitForPinPrompt + pin + waitForLastName + '1';

  log(`DTMF sequence length: ${sendDigitsSequence.length} chars`, 'info');

  try {
    const call = await twilioClient.calls.create({
      to: targetNumber,
      from: twilioNumber,
      url: `${baseUrl}/twiml/answer?callId=${callId}`,
      statusCallback: `${baseUrl}/webhook/status?callId=${callId}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });

    const callConfig = pendingCalls.get(callId);
    callConfig.twilioCallSid = call.sid;
    callConfig.sendDigits = sendDigitsSequence;
    activeCalls.set(call.sid, callConfig);

    log(`Call created with SID: ${call.sid}`, 'success');

    return {
      success: true,
      callId,
      callSid: call.sid,
      message: 'Call initiated successfully'
    };
  } catch (error) {
    log(`Error creating call: ${error.message}`, 'error');
    throw error;
  }
}

function isE164(num) {
  return /^\+\d{10,15}$/.test(num);
}

app.post('/api/call', async (req, res) => {
  try {
    let { targetNumber, pin, notifyNumber, fromNumber } = req.body;

    if (!targetNumber || !pin || !notifyNumber) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (pin.length !== 6 || !/^\d+$/.test(pin)) {
      return res.status(400).json({ error: 'PIN must be exactly 6 digits' });
    }

    if (!isE164(targetNumber)) {
      return res.status(400).json({ error: 'targetNumber must be in format +15551234567' });
    }

    if (!isE164(notifyNumber)) {
      return res.status(400).json({ error: 'notifyNumber must be in format +15551234567' });
    }

    const result = await initiateCall(targetNumber, pin, notifyNumber, fromNumber);
    res.json(result);
  } catch (error) {
    console.error('Error initiating call:', error);
    res.status(500).json({ error: 'Failed to initiate call', details: error.message });
  }
});

app.post('/api/call-auto', async (req, res) => {
  try {
    let { targetNumber, pin, notifyNumber, fromNumber } = req.body;

    if (!targetNumber || !pin || !notifyNumber) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!isE164(targetNumber) || !isE164(notifyNumber)) {
      return res.status(400).json({ error: 'Phone numbers must be in format +15551234567' });
    }

    const result = await initiateCall(targetNumber, pin, notifyNumber, fromNumber);
    res.json(result);
  } catch (error) {
    console.error('Error initiating call:', error);
    res.status(500).json({ error: 'Failed to initiate call', details: error.message });
  }
});

app.post('/twiml/answer', (req, res) => {
  const { callId } = req.query;
  const callConfig = pendingCalls.get(callId);
  const baseUrl = process.env.BASE_URL;
  const log = (msg, type) => logToConsole(callId, msg, type);

  log('Call answered, sending DTMF sequence', 'success');

  const twiml = new twilio.twiml.VoiceResponse();

  if (!callConfig) {
    log('Configuration not found', 'error');
    twiml.say('Configuration not found');
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  twiml.play({ digits: callConfig.sendDigits });
  twiml.pause({ length: 2 });

  log('DTMF sequence sent, now listening for result', 'info');

  twiml.gather({
    input: 'speech',
    timeout: 12,
    speechTimeout: 3,
    action: `${baseUrl}/twiml/result?callId=${callId}`,
    hints: 'do not test today, do not test, you do not need to test, required to test, you are required to test today, must test'
  });

  twiml.redirect(`${baseUrl}/twiml/fallback?callId=${callId}`);

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/twiml/result', async (req, res) => {
  const { callId } = req.query;
  const speechResult = req.body.SpeechResult || '';
  const confidence = req.body.Confidence || 0;
  const callConfig = pendingCalls.get(callId);
  const log = (msg, type) => logToConsole(callId, msg, type);

  log(`Speech result: "${speechResult}" (confidence: ${confidence})`, 'info');

  const twiml = new twilio.twiml.VoiceResponse();

  if (callConfig) {
    callConfig.transcript.push({ text: speechResult, confidence });

    const lowerSpeech = speechResult.toLowerCase();
    let detected = false;

    if (KEYWORDS.MUST_TEST.some(kw => lowerSpeech.includes(kw))) {
      callConfig.result = 'MUST_TEST';
      log('🚨 DETECTED: TESTING REQUIRED', 'warning');
      detected = true;
      try {
        await sendWhatsApp(
          callConfig.notifyNumber,
          `🚨 TEST REQUIRED for PIN ${callConfig.pin}`,
          callId
        );
      } catch (e) {
        log(`WhatsApp error: ${e.message}`, 'error');
      }
    } else if (KEYWORDS.NO_TEST.some(kw => lowerSpeech.includes(kw))) {
      callConfig.result = 'NO_TEST';
      log('✅ DETECTED: No test required', 'success');
      detected = true;
      try {
        await sendWhatsApp(
          callConfig.notifyNumber,
          `✅ No test today for PIN ${callConfig.pin}`,
          callId
        );
      } catch (e) {
        log(`WhatsApp error: ${e.message}`, 'error');
      }
    }

    if (!detected) {
      callConfig.result = 'UNKNOWN';
      log(`⚠️ Could not match keywords in: "${speechResult}"`, 'warning');
      try {
        await sendWhatsApp(
          callConfig.notifyNumber,
          `⚠️ Call completed. Heard: "${speechResult.substring(0, 100)}". Verify manually.`,
          callId
        );
      } catch (e) {
        log(`WhatsApp error: ${e.message}`, 'error');
      }
    }

    broadcastToClients({
      type: 'result',
      callId,
      result: callConfig.result,
      speech: speechResult
    });
  }

  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/twiml/fallback', async (req, res) => {
  const { callId } = req.query;
  const callConfig = pendingCalls.get(callId);
  const log = (msg, type) => logToConsole(callId, msg, type);

  log('Fallback reached - no speech detected', 'warning');

  if (callConfig && !callConfig.result) {
    callConfig.result = 'UNKNOWN';
    try {
      await sendWhatsApp(
        callConfig.notifyNumber,
        '⚠️ Call completed but no result detected. Please call manually to verify.',
        callId
      );
    } catch (e) {
      log(`WhatsApp error: ${e.message}`, 'error');
    }
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/webhook/status', (req, res) => {
  const { callId } = req.query;
  const { CallStatus, CallDuration } = req.body;
  const log = (msg, type) => logToConsole(callId, msg, type);

  log(`Status: ${CallStatus}, Duration: ${CallDuration || 0}s`, 'info');

  const callConfig = pendingCalls.get(callId);
  if (callConfig) {
    callConfig.status = CallStatus;
    callConfig.duration = CallDuration;
    broadcastToClients({
      type: 'status',
      callId,
      status: CallStatus,
      result: callConfig.result
    });
  }

  res.sendStatus(200);
});

app.get('/api/call/:callId', (req, res) => {
  const callConfig = pendingCalls.get(req.params.callId);
  if (!callConfig) {
    return res.status(404).json({ error: 'Call not found' });
  }
  res.json({
    callId: req.params.callId,
    result: callConfig.result,
    status: callConfig.status,
    duration: callConfig.duration,
    transcript: callConfig.transcript,
    logs: callLogs.get(req.params.callId) || []
  });
});

app.get('/api/schedule', (req, res) => {
  res.json({
    hasSchedule: savedScheduleConfig !== null,
    schedule: savedScheduleConfig
  });
});

app.post('/api/schedule', (req, res) => {
  try {
    const { targetNumber, pin, notifyNumber, hour, minute, timezone, enabled } = req.body;

    scheduledJobs.forEach(job => job.stop());
    scheduledJobs.clear();

    savedScheduleConfig = {
      targetNumber,
      pin,
      notifyNumber,
      hour: parseInt(hour) || 6,
      minute: parseInt(minute) || 0,
      timezone: timezone || 'America/Chicago',
      enabled: enabled !== false
    };

    if (savedScheduleConfig.enabled) {
      const cronExpr = `${savedScheduleConfig.minute} ${savedScheduleConfig.hour} * * *`;
      console.log(`Creating schedule: ${cronExpr} (${savedScheduleConfig.timezone})`);

      const job = cron.schedule(
        cronExpr,
        async () => {
          console.log(`⏰ Scheduled call triggered at ${new Date().toISOString()}`);
          try {
            await initiateCall(
              savedScheduleConfig.targetNumber,
              savedScheduleConfig.pin,
              savedScheduleConfig.notifyNumber
            );
          } catch (error) {
            console.error('Scheduled call failed:', error);
            try {
              await sendWhatsApp(
                savedScheduleConfig.notifyNumber,
                '❌ Scheduled probation call FAILED. Please call manually.',
                'schedule'
              );
            } catch (e) {}
          }
        },
        { timezone: savedScheduleConfig.timezone }
      );
      scheduledJobs.set('daily', job);
    }

    res.json({ success: true, schedule: savedScheduleConfig });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/schedule', (req, res) => {
  scheduledJobs.forEach(job => job.stop());
  scheduledJobs.clear();
  savedScheduleConfig = null;
  res.json({ success: true });
});

app.post('/api/test-sms', async (req, res) => {
  try {
    const { notifyNumber } = req.body;

    if (!notifyNumber || !isE164(notifyNumber)) {
      return res.status(400).json({ error: 'notifyNumber must be in format +15551234567' });
    }

    const testCallId = `test_${Date.now()}`;
    const body = 'Your appointment is coming up on July 21 at 3PM';

    await sendWhatsApp(notifyNumber, body, testCallId);

    res.json({
      success: true,
      logs: callLogs.get(testCallId) || []
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      code: error.code
    });
  }
});

async function sendWhatsApp(to, body, callId) {
  const fromNumber = 'whatsapp:+14155238886';
  const toNumber = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  logToConsole(
    callId || 'whatsapp',
    `Sending WhatsApp: from ${fromNumber} to ${toNumber} -> "${body}"`,
    'info'
  );

  try {
    const message = await twilioClient.messages.create({
      from: fromNumber,
      to: toNumber,
      body
    });
    logToConsole(callId || 'whatsapp', `WhatsApp sent SID: ${message.sid}`, 'success');
    return message;
  } catch (error) {
    logToConsole(
      callId || 'whatsapp',
      `WhatsApp failed: ${error.code || ''} ${error.message}`,
      'error'
    );
    throw error;
  }
}

wss.on('connection', (ws, req) => {
  if (req.url === '/ws') {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                   Probation Drug Test Call App                ║
╠═══════════════════════════════════════════════════════════════╣
║ Port: ${String(PORT).padEnd(56)}║
║ WhatsApp: ENABLED (from whatsapp:+14155238886)                ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
