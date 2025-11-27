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

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Store active call sessions
const activeCalls = new Map();
const pendingCalls = new Map();

// Store scheduled jobs
let scheduledJobs = new Map();
let savedScheduleConfig = null;

// Keywords to detect in speech
const KEYWORDS = {
  NO_TEST: ['do not test', 'not required', 'no need to test', 'you do not', 'do not need'],
  MUST_TEST: ['required to test', 'must test', 'you are required', 'report for testing']
};

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Core function to initiate a call
async function initiateCall(targetNumber, pin, notifyNumber, fromNumber) {
  const callId = `call_${Date.now()}`;
  const twilioNumber = fromNumber || process.env.TWILIO_PHONE_NUMBER;
  const baseUrl = process.env.BASE_URL;

  console.log(`[${callId}] ========================================`);
  console.log(`[${callId}] Initiating call to ${targetNumber}`);
  console.log(`[${callId}] PIN: ${pin}, Notify: ${notifyNumber}`);
  console.log(`[${callId}] Using Twilio number: ${twilioNumber}`);
  console.log(`[${callId}] Base URL: ${baseUrl}`);

  pendingCalls.set(callId, {
    targetNumber,
    pin,
    notifyNumber,
    transcript: [],
    result: null,
    startTime: new Date()
  });

  // Build DTMF sequence with timing
  // w = 0.5s pause, so wwwwwwwwww = 5 seconds
  const waitForGreeting = 'wwwwwwwwww'; // 5 seconds for "press 1 for english"
  const waitForPinPrompt = 'wwwwwwwwwwwwwwwwwwwwwwww'; // 12 seconds for spanish + pin prompt
  const waitForLastName = 'wwwwwwwwwwwwwwww'; // 8 seconds for last name prompt
  
  const sendDigitsSequence = waitForGreeting + '1' + waitForPinPrompt + pin + waitForLastName + '1';
  
  console.log(`[${callId}] DTMF sequence length: ${sendDigitsSequence.length} chars`);

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

  console.log(`[${callId}] Call created with SID: ${call.sid}`);

  return { 
    success: true, 
    callId,
    callSid: call.sid,
    message: 'Call initiated successfully' 
  };
}

// API endpoint to initiate a call
app.post('/api/call', async (req, res) => {
  try {
    const { targetNumber, pin, notifyNumber, fromNumber } = req.body;

    if (!targetNumber || !pin || !notifyNumber) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (pin.length !== 6 || !/^\d+$/.test(pin)) {
      return res.status(400).json({ error: 'PIN must be exactly 6 digits' });
    }

    const result = await initiateCall(targetNumber, pin, notifyNumber, fromNumber);
    res.json(result);
  } catch (error) {
    console.error('Error initiating call:', error);
    res.status(500).json({ error: 'Failed to initiate call', details: error.message });
  }
});

// Also keep the old endpoint for compatibility
app.post('/api/call-auto', async (req, res) => {
  try {
    const { targetNumber, pin, notifyNumber, fromNumber } = req.body;

    if (!targetNumber || !pin || !notifyNumber) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await initiateCall(targetNumber, pin, notifyNumber, fromNumber);
    res.json(result);
  } catch (error) {
    console.error('Error initiating call:', error);
    res.status(500).json({ error: 'Failed to initiate call', details: error.message });
  }
});

// TwiML - Initial answer
app.post('/twiml/answer', (req, res) => {
  const { callId } = req.query;
  const callConfig = pendingCalls.get(callId);
  const baseUrl = process.env.BASE_URL;

  console.log(`[${callId}] Call answered, sending DTMF sequence`);

  const twiml = new twilio.twiml.VoiceResponse();

  if (!callConfig) {
    twiml.say('Configuration not found');
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Send all the button presses with timing built in
  twiml.play({ digits: callConfig.sendDigits });
  
  // After pressing all buttons, wait and listen for the result
  twiml.pause({ length: 2 });
  
  // Gather speech to detect result
  const gather = twiml.gather({
    input: 'speech',
    timeout: 12,
    speechTimeout: 3,
    action: `${baseUrl}/twiml/result?callId=${callId}`,
    hints: 'do not test today, do not test, you do not need to test, required to test, you are required to test today, must test'
  });

  // If no speech detected, go to fallback
  twiml.redirect(`${baseUrl}/twiml/fallback?callId=${callId}`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// TwiML - Process speech result
app.post('/twiml/result', async (req, res) => {
  const { callId } = req.query;
  const speechResult = req.body.SpeechResult || '';
  const confidence = req.body.Confidence || 0;
  const callConfig = pendingCalls.get(callId);

  console.log(`[${callId}] Speech result: "${speechResult}" (confidence: ${confidence})`);

  const twiml = new twilio.twiml.VoiceResponse();

  if (callConfig) {
    callConfig.transcript.push({ text: speechResult, confidence });
    const lowerSpeech = speechResult.toLowerCase();

    let detected = false;

    if (KEYWORDS.MUST_TEST.some(kw => lowerSpeech.includes(kw))) {
      callConfig.result = 'MUST_TEST';
      console.log(`[${callId}] 🚨 DETECTED: TESTING REQUIRED`);
      detected = true;
      try {
        await sendSMS(callConfig.notifyNumber, 
          `🚨 DRUG TEST ALERT: You ARE REQUIRED to test today! (PIN: ${callConfig.pin}) - ${getTimestamp()}`);
      } catch (e) { console.error('SMS error:', e); }
    } else if (KEYWORDS.NO_TEST.some(kw => lowerSpeech.includes(kw))) {
      callConfig.result = 'NO_TEST';
      console.log(`[${callId}] ✅ DETECTED: No test required`);
      detected = true;
      try {
        await sendSMS(callConfig.notifyNumber,
          `✅ NO TEST TODAY: You do NOT need to test today. (PIN: ${callConfig.pin}) - ${getTimestamp()}`);
      } catch (e) { console.error('SMS error:', e); }
    }

    if (!detected) {
      callConfig.result = 'UNKNOWN';
      console.log(`[${callId}] ⚠️ Could not match keywords in: "${speechResult}"`);
      try {
        await sendSMS(callConfig.notifyNumber,
          `📞 Probation call completed. Heard: "${speechResult.substring(0, 100)}". Please verify manually if needed. (PIN: ${callConfig.pin}) - ${getTimestamp()}`);
      } catch (e) { console.error('SMS error:', e); }
    }

    broadcastToClients({ type: 'result', callId, result: callConfig.result, speech: speechResult });
  }

  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

// TwiML - Fallback if no speech detected
app.post('/twiml/fallback', async (req, res) => {
  const { callId } = req.query;
  const callConfig = pendingCalls.get(callId);

  console.log(`[${callId}] Fallback reached - no speech detected`);

  if (callConfig && !callConfig.result) {
    callConfig.result = 'UNKNOWN';
    try {
      await sendSMS(callConfig.notifyNumber,
        `📞 Probation call completed but could not detect result. Please call manually to verify. (PIN: ${callConfig.pin}) - ${getTimestamp()}`);
    } catch (e) { console.error('SMS error:', e); }
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

// Status webhook
app.post('/webhook/status', (req, res) => {
  const { callId } = req.query;
  const { CallStatus, CallDuration } = req.body;

  console.log(`[${callId}] Status: ${CallStatus}, Duration: ${CallDuration || 0}s`);

  const callConfig = pendingCalls.get(callId);
  if (callConfig) {
    callConfig.status = CallStatus;
    callConfig.duration = CallDuration;
    broadcastToClients({ type: 'status', callId, status: CallStatus, result: callConfig.result });
  }

  res.sendStatus(200);
});

// Get call status
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
    transcript: callConfig.transcript
  });
});

// ============== SCHEDULING ==============

app.get('/api/schedule', (req, res) => {
  res.json({
    hasSchedule: savedScheduleConfig !== null,
    schedule: savedScheduleConfig
  });
});

app.post('/api/schedule', (req, res) => {
  try {
    const { targetNumber, pin, notifyNumber, hour, minute, timezone, enabled } = req.body;

    // Clear existing
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

      const job = cron.schedule(cronExpr, async () => {
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
            await sendSMS(savedScheduleConfig.notifyNumber,
              `⚠️ Scheduled probation call FAILED. Please call manually. - ${getTimestamp()}`);
          } catch (e) {}
        }
      }, { timezone: savedScheduleConfig.timezone });

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

// Test SMS endpoint
app.post('/api/test-sms', async (req, res) => {
  try {
    const { notifyNumber } = req.body;
    await sendSMS(notifyNumber, `✅ Test SMS from Probation Call App - ${getTimestamp()}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message, code: error.code });
  }
});

// ============== HELPERS ==============

async function sendSMS(to, body) {
  console.log(`📱 Sending SMS to ${to}: ${body.substring(0, 50)}...`);
  const message = await twilioClient.messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to
  });
  console.log(`📱 SMS sent: ${message.sid}`);
  return message;
}

function getTimestamp() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
}

// WebSocket
const wsClients = new Set();

function broadcastToClients(data) {
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

wss.on('connection', (ws, req) => {
  if (req.url === '/ws') {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
  }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║     Probation Drug Test Call App                              ║
╠═══════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                                    ║
║  Twilio: ${process.env.TWILIO_PHONE_NUMBER || 'NOT SET'}
╚═══════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
