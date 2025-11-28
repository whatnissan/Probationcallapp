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

app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const pendingCalls = new Map();
const callLogs = new Map();
const wsClients = new Set();
const scheduledJobs = new Map();

const PACKAGES = {
  starter: { name: 'Starter', credits: 30, price: 999 },
  standard: { name: 'Standard', credits: 90, price: 2499 },
  value: { name: 'Value', credits: 180, price: 3999 }
};

const KEYWORDS = {
  NO_TEST: ['do not test', 'not required', 'no need', 'you do not', 'do not need', 'not test'],
  MUST_TEST: ['required to test', 'must test', 'you are required', 'report for', 'required today']
};

function log(callId, msg, type) {
  const entry = { timestamp: new Date().toISOString(), message: msg, type: type || 'info' };
  if (callId) {
    if (!callLogs.has(callId)) callLogs.set(callId, []);
    callLogs.get(callId).push(entry);
  }
  console.log('[' + (callId || 'SYS') + '] ' + msg);
  broadcastToClients({ type: 'log', callId: callId, log: entry });
}

function broadcastToClients(data) {
  wsClients.forEach(function(c) { 
    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data)); 
  });
}

async function auth(req, res, next) {
  var authHeader = req.headers.authorization;
  var token = authHeader ? authHeader.replace('Bearer ', '') : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  
  var result = await supabase.auth.getUser(token);
  if (result.error || !result.data.user) return res.status(401).json({ error: 'Invalid token' });
  
  var user = result.data.user;
  var profileResult = await supabase.from('profiles').select('*').eq('id', user.id).single();
  var profile = profileResult.data;
  
  if (!profile) {
    await supabase.from('profiles').insert({ id: user.id, email: user.email, credits: 1 });
    profile = { id: user.id, email: user.email, credits: 1 };
  }
  
  req.user = user;
  req.profile = profile;
  next();
}

app.get('/', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/login', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/dashboard', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/health', function(req, res) { res.json({ status: 'ok', time: new Date().toISOString() }); });

app.get('/api/user', auth, async function(req, res) {
  var historyResult = await supabase.from('call_history').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(30);
  var scheduleResult = await supabase.from('user_schedules').select('*').eq('user_id', req.user.id).single();
  res.json({ user: req.user, profile: req.profile, history: historyResult.data || [], schedule: scheduleResult.data });
});

app.post('/api/redeem', auth, async function(req, res) {
  var code = req.body.code;
  if (!code) return res.status(400).json({ error: 'No code provided' });
  
  var promoResult = await supabase.from('promo_codes').select('*').eq('code', code.toUpperCase()).single();
  var promo = promoResult.data;
  if (!promo) return res.status(404).json({ error: 'Invalid promo code' });
  if (promo.times_used >= promo.max_uses) return res.status(400).json({ error: 'Promo code expired' });
  
  var existingResult = await supabase.from('promo_redemptions').select('*').eq('user_id', req.user.id).eq('promo_code_id', promo.id).single();
  if (existingResult.data) return res.status(400).json({ error: 'You already used this code' });
  
  await supabase.from('promo_redemptions').insert({ user_id: req.user.id, promo_code_id: promo.id });
  await supabase.from('promo_codes').update({ times_used: promo.times_used + 1 }).eq('id', promo.id);
  await supabase.from('profiles').update({ credits: req.profile.credits + promo.credits }).eq('id', req.user.id);
  
  res.json({ success: true, credits: promo.credits });
});

app.post('/api/schedule', auth, async function(req, res) {
  var data = {
    user_id: req.user.id,
    target_number: req.body.targetNumber,
    pin: req.body.pin,
    notify_number: req.body.notifyNumber,
    hour: parseInt(req.body.hour) || 6,
    minute: parseInt(req.body.minute) || 0,
    timezone: req.body.timezone || 'America/Chicago',
    enabled: req.body.enabled !== false,
    updated_at: new Date().toISOString()
  };
  
  var existingResult = await supabase.from('user_schedules').select('id').eq('user_id', req.user.id).single();
  
  if (existingResult.data) {
    await supabase.from('user_schedules').update(data).eq('user_id', req.user.id);
  } else {
    await supabase.from('user_schedules').insert(data);
  }
  
  rescheduleUser(req.user.id, data);
  res.json({ success: true });
});

app.delete('/api/schedule', auth, async function(req, res) {
  await supabase.from('user_schedules').delete().eq('user_id', req.user.id);
  if (scheduledJobs.has(req.user.id)) {
    scheduledJobs.get(req.user.id).stop();
    scheduledJobs.delete(req.user.id);
  }
  res.json({ success: true });
});

function rescheduleUser(userId, sched) {
  if (scheduledJobs.has(userId)) {
    scheduledJobs.get(userId).stop();
    scheduledJobs.delete(userId);
  }
  if (!sched.enabled) return;
  
  var expr = sched.minute + ' ' + sched.hour + ' * * *';
  console.log('[SCHED] User ' + userId + ': ' + expr);
  
  var job = cron.schedule(expr, async function() {
    console.log('[SCHED] Running for ' + userId);
    var profileResult = await supabase.from('profiles').select('credits').eq('id', userId).single();
    var profile = profileResult.data;
    
    if (!profile || profile.credits < 1) {
      await notify(sched.notify_number, 'Warning: Scheduled call skipped - no credits!', 'sched');
      return;
    }
    
    try {
      await initiateCall(sched.target_number, sched.pin, sched.notify_number, userId);
      await supabase.from('profiles').update({ credits: profile.credits - 1 }).eq('id', userId);
    } catch (e) {
      await notify(sched.notify_number, 'Scheduled call failed. Please call manually!', 'sched');
    }
  }, { timezone: sched.timezone });
  
  scheduledJobs.set(userId, job);
}

async function loadAllSchedules() {
  var result = await supabase.from('user_schedules').select('*').eq('enabled', true);
  if (result.data) {
    result.data.forEach(function(s) { rescheduleUser(s.user_id, s); });
    console.log('[SCHED] Loaded ' + result.data.length + ' schedules');
  }
}

app.post('/api/checkout', auth, async function(req, res) {
  var pkg = PACKAGES[req.body.packageId];
  if (!pkg) return res.status(400).json({ error: 'Invalid package' });
  
  try {
    var session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ 
        price_data: { 
          currency: 'usd', 
          product_data: { name: pkg.name + ' - ' + pkg.credits + ' Credits' }, 
          unit_amount: pkg.price 
        }, 
        quantity: 1 
      }],
      mode: 'payment',
      success_url: process.env.BASE_URL + '/dashboard?success=true',
      cancel_url: process.env.BASE_URL + '/dashboard?canceled=true',
      metadata: { user_id: req.user.id, package_id: req.body.packageId, credits: String(pkg.credits) }
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/webhook/stripe', async function(req, res) {
  var event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send('Webhook error');
  }
  
  if (event.type === 'checkout.session.completed') {
    var s = event.data.object;
    var profileResult = await supabase.from('profiles').select('credits').eq('id', s.metadata.user_id).single();
    var currentCredits = profileResult.data ? profileResult.data.credits : 0;
    await supabase.from('profiles').update({ credits: currentCredits + parseInt(s.metadata.credits) }).eq('id', s.metadata.user_id);
    await supabase.from('purchases').insert({ 
      user_id: s.metadata.user_id, 
      stripe_session_id: s.id, 
      package_name: s.metadata.package_id, 
      credits_purchased: parseInt(s.metadata.credits), 
      amount_cents: s.amount_total 
    });
    console.log('[STRIPE] Added ' + s.metadata.credits + ' credits');
  }
  res.json({ received: true });
});

app.post('/api/call', auth, async function(req, res) {
  if (req.profile.credits < 1) return res.status(402).json({ error: 'No credits. Please purchase more.' });
  
  var targetNumber = req.body.targetNumber;
  var pin = req.body.pin;
  var notifyNumber = req.body.notifyNumber;
  
  if (!targetNumber || !pin || !notifyNumber) return res.status(400).json({ error: 'Missing fields' });
  if (!/^\+\d{10,15}$/.test(targetNumber) || !/^\+\d{10,15}$/.test(notifyNumber)) return res.status(400).json({ error: 'Use E.164 format' });
  if (pin.length !== 6 || !/^\d+$/.test(pin)) return res.status(400).json({ error: 'PIN must be 6 digits' });
  
  var result = await initiateCall(targetNumber, pin, notifyNumber, req.user.id);
  await supabase.from('profiles').update({ credits: req.profile.credits - 1 }).eq('id', req.user.id);
  res.json(result);
});

async function initiateCall(targetNumber, pin, notifyNumber, userId) {
  var callId = 'call_' + Date.now();
  log(callId, 'NEW CALL - ' + targetNumber + ', PIN: ' + pin, 'info');
  
  pendingCalls.set(callId, { targetNumber: targetNumber, pin: pin, notifyNumber: notifyNumber, userId: userId, transcript: [], result: null });
  
  var call = await twilioClient.calls.create({
    to: targetNumber,
    from: process.env.TWILIO_PHONE_NUMBER,
    url: process.env.BASE_URL + '/twiml/answer?callId=' + callId,
    statusCallback: process.env.BASE_URL + '/webhook/status?callId=' + callId,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    timeout: 60
  });
  
  pendingCalls.get(callId).callSid = call.sid;
  log(callId, 'SID: ' + call.sid, 'success');
  return { success: true, callId: callId, callSid: call.sid };
}

app.post('/twiml/answer', function(req, res) {
  var callId = req.query.callId;
  var config = pendingCalls.get(callId);
  var twiml = new twilio.twiml.VoiceResponse();
  
  if (!config) { twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }
  
  log(callId, 'Connected, sending DTMF', 'success');
  twiml.play({ digits: 'wwwwwwwwww1wwwwwwwwwwwwwwwwwwww' + config.pin + 'wwwwwwwwwwwwwwwwwwww1' });
  twiml.pause({ length: 2 });
  twiml.gather({ input: 'speech', timeout: 15, speechTimeout: 3, action: process.env.BASE_URL + '/twiml/result?callId=' + callId, hints: 'do not test, required to test, must test' });
  twiml.redirect(process.env.BASE_URL + '/twiml/fallback?callId=' + callId);
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/result', async function(req, res) {
  var callId = req.query.callId;
  var speech = req.body.SpeechResult || '';
  var config = pendingCalls.get(callId);
  var twiml = new twilio.twiml.VoiceResponse();
  
  log(callId, 'SPEECH: "' + speech + '"', 'info');
  
  if (config) {
    var lower = speech.toLowerCase();
    var result = 'UNKNOWN';
    
    if (KEYWORDS.MUST_TEST.some(function(k) { return lower.includes(k); })) {
      result = 'MUST_TEST';
      log(callId, 'TEST REQUIRED!', 'warning');
      await notify(config.notifyNumber, 'TEST REQUIRED! PIN: ' + config.pin, callId);
    } else if (KEYWORDS.NO_TEST.some(function(k) { return lower.includes(k); })) {
      result = 'NO_TEST';
      log(callId, 'No test today', 'success');
      await notify(config.notifyNumber, 'No test today. PIN: ' + config.pin, callId);
    } else {
      await notify(config.notifyNumber, 'Heard: "' + speech.slice(0,80) + '". Verify manually.', callId);
    }
    
    config.result = result;
    if (config.userId) {
      await supabase.from('call_history').insert({ user_id: config.userId, call_sid: config.callSid, target_number: config.targetNumber, pin_used: config.pin, result: result });
    }
    broadcastToClients({ type: 'result', callId: callId, result: result, speech: speech });
  }
  
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/fallback', async function(req, res) {
  var callId = req.query.callId;
  var config = pendingCalls.get(callId);
  
  if (config && !config.result) {
    config.result = 'UNKNOWN';
    await notify(config.notifyNumber, 'No result detected. Verify manually.', callId);
    if (config.userId) {
      await supabase.from('call_history').insert({ user_id: config.userId, call_sid: config.callSid, target_number: config.targetNumber, pin_used: config.pin, result: 'UNKNOWN' });
    }
  }
  
  var twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

app.post('/webhook/status', function(req, res) {
  var callId = req.query.callId;
  var config = pendingCalls.get(callId);
  if (config) {
    config.status = req.body.CallStatus;
    broadcastToClients({ type: 'status', callId: callId, status: req.body.CallStatus, result: config.result });
  }
  log(callId, 'STATUS: ' + req.body.CallStatus, 'info');
  res.sendStatus(200);
});

async function notify(to, body, callId) {
  var toWA = to.startsWith('whatsapp:') ? to : 'whatsapp:' + to;
  try {
    await twilioClient.messages.create({ from: 'whatsapp:+14155238886', to: toWA, body: body });
    log(callId, 'WhatsApp sent', 'success');
  } catch (e) { 
    log(callId, 'WhatsApp failed: ' + e.message, 'error'); 
  }
}

app.post('/api/test-sms', auth, async function(req, res) {
  await notify(req.body.notifyNumber, 'Test from ProbationCall', 'test');
  res.json({ success: true });
});

wss.on('connection', function(ws, req) {
  if (req.url === '/ws') {
    wsClients.add(ws);
    ws.on('close', function() { wsClients.delete(ws); });
  }
});

var PORT = process.env.PORT || 3000;
server.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
  loadAllSchedules();
});

module.exports = app;
