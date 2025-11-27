require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const path = require('path');
const cron = require('node-cron');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Stripe webhook needs raw body
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Initialize clients
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Storage
const pendingCalls = new Map();
const callLogs = new Map();
const wsClients = new Set();
let scheduledJobs = new Map();
let savedScheduleConfig = null;

// Credit packages
const PACKAGES = {
  starter: { name: 'Starter', credits: 30, price: 999, desc: '1 Month' },
  standard: { name: 'Standard', credits: 90, price: 2499, desc: '3 Months' },
  value: { name: 'Value', credits: 180, price: 3999, desc: '6 Months' }
};

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
  console.log(`[${callId || 'SYS'}] ${message}`);
  broadcastToClients({ type: 'log', callId, log: entry });
}

function broadcastToClients(data) {
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}

// ========== AUTH MIDDLEWARE ==========
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  req.user = user;
  next();
}

// ========== PAGES ==========
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ========== USER API ==========
app.get('/api/user', authMiddleware, async (req, res) => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', req.user.id)
    .single();

  const { data: history } = await supabase
    .from('call_history')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(30);

  res.json({ user: req.user, profile, history: history || [] });
});

// ========== STRIPE CHECKOUT ==========
app.post('/api/checkout', authMiddleware, async (req, res) => {
  const { packageId } = req.body;
  const pkg = PACKAGES[packageId];
  if (!pkg) return res.status(400).json({ error: 'Invalid package' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `${pkg.name} - ${pkg.credits} Credits` },
          unit_amount: pkg.price
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${process.env.BASE_URL}/dashboard?success=true`,
      cancel_url: `${process.env.BASE_URL}/dashboard?canceled=true`,
      metadata: {
        user_id: req.user.id,
        package_id: packageId,
        credits: pkg.credits.toString()
      }
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== STRIPE WEBHOOK ==========
app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.log('Webhook sig failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.user_id;
    const credits = parseInt(session.metadata.credits);
    const packageId = session.metadata.package_id;

    // Add credits
    const { data: profile } = await supabase
      .from('profiles')
      .select('credits')
      .eq('id', userId)
      .single();

    await supabase
      .from('profiles')
      .update({ credits: (profile?.credits || 0) + credits })
      .eq('id', userId);

    // Record purchase
    await supabase.from('purchases').insert({
      user_id: userId,
      stripe_session_id: session.id,
      package_name: packageId,
      credits_purchased: credits,
      amount_cents: session.amount_total
    });

    console.log(`✅ Added ${credits} credits to user ${userId}`);
  }

  res.json({ received: true });
});

// ========== CALL API (with credits) ==========
app.post('/api/call', authMiddleware, async (req, res) => {
  const { targetNumber, pin, notifyNumber } = req.body;

  // Check credits
  const { data: profile } = await supabase
    .from('profiles')
    .select('credits')
    .eq('id', req.user.id)
    .single();

  if (!profile || profile.credits < 1) {
    return res.status(402).json({ error: 'No credits remaining. Please purchase more.' });
  }

  // Validate
  if (!targetNumber || !pin || !notifyNumber) return res.status(400).json({ error: 'Missing fields' });
  if (!/^\+\d{10,15}$/.test(targetNumber) || !/^\+\d{10,15}$/.test(notifyNumber)) {
    return res.status(400).json({ error: 'Use E.164 format: +15551234567' });
  }
  if (pin.length !== 6 || !/^\d+$/.test(pin)) return res.status(400).json({ error: 'PIN must be 6 digits' });

  try {
    const result = await initiateCall(targetNumber, pin, notifyNumber, req.user.id);

    // Deduct credit
    await supabase
      .from('profiles')
      .update({ credits: profile.credits - 1 })
      .eq('id', req.user.id);

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function initiateCall(targetNumber, pin, notifyNumber, userId) {
  const callId = `call_${Date.now()}`;
  const baseUrl = process.env.BASE_URL;

  log(callId, `NEW CALL - Target: ${targetNumber}, PIN: ${pin}`, 'info');

  pendingCalls.set(callId, { targetNumber, pin, notifyNumber, userId, transcript: [], result: null });

  const call = await twilioClient.calls.create({
    to: targetNumber,
    from: process.env.TWILIO_PHONE_NUMBER,
    url: `${baseUrl}/twiml/answer?callId=${callId}`,
    statusCallback: `${baseUrl}/webhook/status?callId=${callId}`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    timeout: 60
  });

  pendingCalls.get(callId).callSid = call.sid;
  log(callId, `Call SID: ${call.sid}`, 'success');

  return { success: true, callId, callSid: call.sid };
}

// ========== TWIML ==========
app.post('/twiml/answer', (req, res) => {
  const { callId } = req.query;
  const config = pendingCalls.get(callId);
  const baseUrl = process.env.BASE_URL;
  const twiml = new twilio.twiml.VoiceResponse();

  if (!config) {
    twiml.say('Error');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  log(callId, 'Call connected, sending DTMF...', 'success');
  const seq = 'wwwwwwwwww' + '1' + 'wwwwwwwwwwwwwwwwwwww' + config.pin + 'wwwwwwwwwwwwwwwwwwww' + '1';

  twiml.play({ digits: seq });
  twiml.pause({ length: 2 });
  twiml.gather({
    input: 'speech', timeout: 15, speechTimeout: 3,
    action: `${baseUrl}/twiml/result?callId=${callId}`,
    hints: 'do not test today, required to test, must test'
  });
  twiml.redirect(`${baseUrl}/twiml/fallback?callId=${callId}`);

  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/result', async (req, res) => {
  const { callId } = req.query;
  const speech = req.body.SpeechResult || '';
  const config = pendingCalls.get(callId);
  const twiml = new twilio.twiml.VoiceResponse();

  log(callId, `SPEECH: "${speech}"`, 'info');

  if (config) {
    const lower = speech.toLowerCase();
    let result = 'UNKNOWN';

    if (KEYWORDS.MUST_TEST.some(k => lower.includes(k))) {
      result = 'MUST_TEST';
      log(callId, '🚨 TESTING REQUIRED!', 'warning');
      await notify(config.notifyNumber, `🚨 TEST REQUIRED! PIN: ${config.pin}`, callId);
    } else if (KEYWORDS.NO_TEST.some(k => lower.includes(k))) {
      result = 'NO_TEST';
      log(callId, '✅ No test today', 'success');
      await notify(config.notifyNumber, `✅ No test today. PIN: ${config.pin}`, callId);
    } else {
      await notify(config.notifyNumber, `⚠️ Heard: "${speech.slice(0,80)}". Verify manually.`, callId);
    }

    config.result = result;

    // Save to history
    if (config.userId) {
      await supabase.from('call_history').insert({
        user_id: config.userId,
        call_sid: config.callSid,
        target_number: config.targetNumber,
        pin_used: config.pin,
        result: result
      });
    }

    broadcastToClients({ type: 'result', callId, result, speech });
  }

  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/fallback', async (req, res) => {
  const { callId } = req.query;
  const config = pendingCalls.get(callId);

  if (config && !config.result) {
    config.result = 'UNKNOWN';
    await notify(config.notifyNumber, `⚠️ Call done, no result detected. Verify manually.`, callId);
    if (config.userId) {
      await supabase.from('call_history').insert({
        user_id: config.userId, call_sid: config.callSid,
        target_number: config.targetNumber, pin_used: config.pin, result: 'UNKNOWN'
      });
    }
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

app.post('/webhook/status', (req, res) => {
  const { callId } = req.query;
  const { CallStatus, CallDuration } = req.body;
  log(callId, `STATUS: ${CallStatus} | ${CallDuration || 0}s`, 'info');

  const config = pendingCalls.get(callId);
  if (config) {
    config.status = CallStatus;
    broadcastToClients({ type: 'status', callId, status: CallStatus, result: config.result });
  }
  res.sendStatus(200);
});

// ========== NOTIFICATIONS ==========
async function notify(to, body, callId) {
  const toWA = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  try {
    await twilioClient.messages.create({ from: 'whatsapp:+14155238886', to: toWA, body });
    log(callId, `📱 WhatsApp sent`, 'success');
  } catch (e) {
    log(callId, `📱 WhatsApp failed: ${e.message}`, 'error');
  }
}

app.post('/api/test-sms', authMiddleware, async (req, res) => {
  const { notifyNumber } = req.body;
  if (!notifyNumber) return res.status(400).json({ error: 'Missing number' });
  await notify(notifyNumber, '✅ Test from Probation Call App', 'test');
  res.json({ success: true });
});

// ========== WEBSOCKET ==========
wss.on('connection', (ws, req) => {
  if (req.url === '/ws') {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
  }
});

// ========== START ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}\n`);
});

module.exports = app;
