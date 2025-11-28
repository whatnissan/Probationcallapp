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

// DEV ACCOUNTS - these emails get unlimited credits
const DEV_EMAILS = ['whatnissan@gmail.com', 'whatnissan@protonmail.com'];

app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const pendingCalls = new Map();
const wsClients = new Set();
const scheduledJobs = new Map();

// Phone numbers
const TWILIO_VOICE_NUMBER = process.env.TWILIO_PHONE_NUMBER; // For calls
const TWILIO_SMS_NUMBER = process.env.TWILIO_SMS_NUMBER || process.env.TWILIO_PHONE_NUMBER; // For SMS
const WHATSAPP_SANDBOX = 'whatsapp:+15558965863';

const PACKAGES = {
  starter: { name: 'Starter', credits: 30, price: 999 },
  standard: { name: 'Standard', credits: 90, price: 2499 },
  value: { name: 'Value', credits: 180, price: 3999 }
};

const KEYWORDS = {
  NO_TEST: ['do not test', 'not required', 'no need', 'you do not', 'do not need', 'not test'],
  MUST_TEST: ['required to test', 'must test', 'you are required', 'report for', 'required today']
};

function isDev(email) {
  return DEV_EMAILS.includes(email.toLowerCase());
}

function log(callId, msg, type) {
  var entry = { timestamp: new Date().toISOString(), message: msg, type: type || 'info' };
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
  
  try {
    var result = await supabase.auth.getUser(token);
    if (result.error || !result.data.user) return res.status(401).json({ error: 'Invalid token' });
    
    var user = result.data.user;
    var profileResult = await supabase.from('profiles').select('*').eq('id', user.id).single();
    var profile = profileResult.data;
    
    if (!profile) {
      var startCredits = isDev(user.email) ? 9999 : 1;
      await supabase.from('profiles').insert({ id: user.id, email: user.email, credits: startCredits });
      profile = { id: user.id, email: user.email, credits: startCredits };
    }
    
    // Dev accounts always have unlimited credits
    if (isDev(user.email)) {
      profile.credits = 9999;
      profile.isDev = true;
    }
    
    req.user = user;
    req.profile = profile;
    next();
  } catch(e) {
    console.error('Auth error:', e);
    res.status(500).json({ error: 'Auth error' });
  }
}

app.get('/', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/login', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/dashboard', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/health', function(req, res) { res.json({ status: 'ok', time: new Date().toISOString() }); });

app.get('/api/user', auth, async function(req, res) {
  var historyResult = await supabase.from('call_history').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(30);
  var scheduleResult = await supabase.from('user_schedules').select('*').eq('user_id', req.user.id).single();
  var schedule = (scheduleResult.error || !scheduleResult.data) ? null : scheduleResult.data;
  res.json({ 
    user: req.user, 
    profile: req.profile, 
    history: historyResult.data || [], 
    schedule: scheduleResult.data || null,
    isDev: isDev(req.user.email)
  });
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
    notify_method: req.body.notifyMethod || 'whatsapp',
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
  console.log('[SCHED] User ' + userId + ' scheduled at: ' + expr + ' ' + sched.timezone);
  
  var job = cron.schedule(expr, async function() {
    console.log('[SCHED] RUNNING scheduled call for ' + userId);
    try {
      var profileResult = await supabase.from('profiles').select('credits, email').eq('id', userId).single();
      var profile = profileResult.data;
      
      // Check credits (skip for dev accounts)
      if (!profile) {
        console.log('[SCHED] No profile for ' + userId);
        return;
      }
      
      var isDevUser = isDev(profile.email);
      
      if (!isDevUser && profile.credits < 1) {
        console.log('[SCHED] No credits for ' + userId);
        await notify(sched.notify_number, sched.notify_method || 'whatsapp', 'ProbationCall: Scheduled call skipped - no credits remaining!', 'sched');
        return;
      }
      
      await initiateCall(sched.target_number, sched.pin, sched.notify_number, sched.notify_method || 'whatsapp', userId);
      
      // Only deduct credits for non-dev users
      if (!isDevUser) {
        await supabase.from('profiles').update({ credits: profile.credits - 1 }).eq('id', userId);
      }
      console.log('[SCHED] Call initiated for ' + userId + (isDevUser ? ' (DEV - no credit deduction)' : ''));
    } catch (e) {
      console.error('[SCHED] Error for ' + userId + ':', e);
      await notify(sched.notify_number, sched.notify_method || 'whatsapp', 'ProbationCall: Scheduled call failed! Please call manually.', 'sched');
    }
  }, { timezone: sched.timezone });
  
  scheduledJobs.set(userId, job);
}

async function loadAllSchedules() {
  try {
    var result = await supabase.from('user_schedules').select('*').eq('enabled', true);
    if (result.data && result.data.length > 0) {
      result.data.forEach(function(s) { rescheduleUser(s.user_id, s); });
      console.log('[SCHED] Loaded ' + result.data.length + ' active schedules');
    } else {
      console.log('[SCHED] No active schedules found');
    }
  } catch(e) {
    console.error('[SCHED] Error loading schedules:', e);
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
    console.log('[STRIPE] Added ' + s.metadata.credits + ' credits to ' + s.metadata.user_id);
  }
  res.json({ received: true });
});

app.post('/api/call', auth, async function(req, res) {
  console.log('[API] Call request from ' + req.user.email + (req.profile.isDev ? ' (DEV)' : ''));
  
  // Check credits (skip for dev accounts)
  if (!req.profile.isDev && req.profile.credits < 1) {
    console.log('[API] No credits for ' + req.user.email);
    return res.status(402).json({ error: 'No credits. Please purchase more.' });
  }
  
  var targetNumber = req.body.targetNumber;
  var pin = req.body.pin;
  var notifyNumber = req.body.notifyNumber;
  var notifyMethod = req.body.notifyMethod || 'whatsapp';
  
  if (!targetNumber || !pin || !notifyNumber) return res.status(400).json({ error: 'Missing fields' });
  if (!/^\+\d{10,15}$/.test(targetNumber) || !/^\+\d{10,15}$/.test(notifyNumber)) return res.status(400).json({ error: 'Use E.164 format (+1234567890)' });
  if (pin.length !== 6 || !/^\d+$/.test(pin)) return res.status(400).json({ error: 'PIN must be 6 digits' });
  
  try {
    var result = await initiateCall(targetNumber, pin, notifyNumber, notifyMethod, req.user.id);
    
    // Only deduct credits for non-dev users
    if (!req.profile.isDev) {
      await supabase.from('profiles').update({ credits: req.profile.credits - 1 }).eq('id', req.user.id);
      console.log('[API] Credit deducted');
    } else {
      console.log('[API] DEV account - no credit deducted');
    }
    
    res.json(result);
  } catch(e) {
    console.error('[API] Call error:', e);
    res.status(500).json({ error: 'Call failed: ' + e.message });
  }
});

async function initiateCall(targetNumber, pin, notifyNumber, notifyMethod, userId) {
  var callId = 'call_' + Date.now();
  log(callId, 'Starting call to ' + targetNumber, 'info');
  log(callId, 'PIN: ' + pin, 'info');
  log(callId, 'Notify: ' + notifyNumber + ' via ' + notifyMethod, 'info');
  
  pendingCalls.set(callId, { 
    targetNumber: targetNumber, 
    pin: pin, 
    notifyNumber: notifyNumber,
    notifyMethod: notifyMethod,
    userId: userId, 
    result: null,
    startTime: Date.now()
  });
  
  var call = await twilioClient.calls.create({
    to: targetNumber,
    from: TWILIO_VOICE_NUMBER,
    url: process.env.BASE_URL + '/twiml/answer?callId=' + callId,
    statusCallback: process.env.BASE_URL + '/webhook/status?callId=' + callId,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    timeout: 60
  });
  
  pendingCalls.get(callId).callSid = call.sid;
  log(callId, 'Call SID: ' + call.sid, 'success');
  return { success: true, callId: callId, callSid: call.sid };
}

app.post('/twiml/answer', function(req, res) {
  var callId = req.query.callId;
  var config = pendingCalls.get(callId);
  var twiml = new twilio.twiml.VoiceResponse();
  
  if (!config) { 
    log(callId, 'No config found, hanging up', 'error');
    twiml.hangup(); 
    return res.type('text/xml').send(twiml.toString()); 
  }
  
  log(callId, 'Call answered, sending DTMF sequence', 'success');
  
  twiml.play({ digits: 'wwwwwwwwww1wwwwwwwwwwwwwwwwwwww' + config.pin + 'wwwwwwwwwwwwwwwwwwww1' });
  twiml.pause({ length: 2 });
  
  log(callId, 'Listening for speech...', 'info');
  twiml.gather({ 
    input: 'speech', 
    timeout: 15, 
    speechTimeout: 3, 
    action: process.env.BASE_URL + '/twiml/result?callId=' + callId, 
    hints: 'do not test, required to test, must test, not required, you are required' 
  });
  
  twiml.redirect(process.env.BASE_URL + '/twiml/fallback?callId=' + callId);
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/result', async function(req, res) {
  var callId = req.query.callId;
  var speech = req.body.SpeechResult || '';
  var confidence = req.body.Confidence || 'N/A';
  var config = pendingCalls.get(callId);
  var twiml = new twilio.twiml.VoiceResponse();
  
  log(callId, 'Speech: "' + speech + '" (confidence: ' + confidence + ')', 'info');
  
  if (config && !config.result) {
    var lower = speech.toLowerCase();
    var result = 'UNKNOWN';
    
    if (KEYWORDS.MUST_TEST.some(function(k) { return lower.indexOf(k) >= 0; })) {
      result = 'MUST_TEST';
      log(callId, '🚨 RESULT: TEST REQUIRED!', 'warning');
    } else if (KEYWORDS.NO_TEST.some(function(k) { return lower.indexOf(k) >= 0; })) {
      result = 'NO_TEST';
      log(callId, '✅ RESULT: No test today', 'success');
    } else {
      log(callId, '⚠️ RESULT: Unknown', 'warning');
    }
    
    config.result = result;
    
    var message;
    if (result === 'MUST_TEST') {
      message = '🚨 TEST REQUIRED! 🚨\n\nYour color was called. Report for testing today.\n\nPIN: ' + config.pin;
    } else if (result === 'NO_TEST') {
      message = '✅ No test today!\n\nYour color was NOT called.\n\nPIN: ' + config.pin;
    } else {
      message = '⚠️ Could not determine result.\n\nHeard: "' + speech.slice(0, 100) + '"\n\nPlease verify manually.\nPIN: ' + config.pin;
    }
    
    await notify(config.notifyNumber, config.notifyMethod, message, callId);
    
    if (config.userId) {
      await supabase.from('call_history').insert({ 
        user_id: config.userId, 
        call_sid: config.callSid, 
        target_number: config.targetNumber, 
        pin_used: config.pin, 
        result: result 
      });
      log(callId, 'Saved to history', 'info');
    }
    
    broadcastToClients({ type: 'result', callId: callId, result: result, speech: speech });
  }
  
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/fallback', async function(req, res) {
  var callId = req.query.callId;
  var config = pendingCalls.get(callId);
  
  log(callId, 'Fallback - no speech detected', 'warning');
  
  if (config && !config.result) {
    config.result = 'UNKNOWN';
    
    var message = '⚠️ Call completed but no result detected.\n\nPlease call manually to verify.\nPIN: ' + config.pin;
    await notify(config.notifyNumber, config.notifyMethod, message, callId);
    
    if (config.userId) {
      await supabase.from('call_history').insert({ 
        user_id: config.userId, 
        call_sid: config.callSid, 
        target_number: config.targetNumber, 
        pin_used: config.pin, 
        result: 'UNKNOWN' 
      });
    }
    
    broadcastToClients({ type: 'result', callId: callId, result: 'UNKNOWN', speech: '' });
  }
  
  var twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

app.post('/webhook/status', function(req, res) {
  var callId = req.query.callId;
  var status = req.body.CallStatus;
  
  log(callId, 'Status: ' + status, 'info');
  
  var config = pendingCalls.get(callId);
  if (config) {
    config.status = status;
    broadcastToClients({ type: 'status', callId: callId, status: status });
  }
  
  res.sendStatus(200);
});

// NOTIFICATION FUNCTION - supports both WhatsApp and SMS
async function notify(to, method, body, callId) {
  log(callId, 'Sending ' + method + ' to ' + to, 'info');
  
  try {
    var messageParams;
    
    if (method === 'sms') {
      // Regular SMS
      messageParams = {
        from: TWILIO_SMS_NUMBER,
        to: to,
        body: body
      };
    } else {
      // WhatsApp (default)
      var toWA = to.indexOf('whatsapp:') === 0 ? to : 'whatsapp:' + to;
      messageParams = {
        from: WHATSAPP_SANDBOX,
        to: toWA,
        body: body
      };
    }
    
    var msg = await twilioClient.messages.create(messageParams);
    log(callId, method.toUpperCase() + ' sent! SID: ' + msg.sid, 'success');
    return { success: true, sid: msg.sid };
  } catch (e) {
    log(callId, method.toUpperCase() + ' FAILED: ' + e.message, 'error');
    console.error('Notification error:', e);
    return { success: false, error: e.message };
  }
}

// TEST ENDPOINTS
app.post('/api/test-whatsapp', auth, async function(req, res) {
  var num = req.body.notifyNumber;
  log('test', 'Testing WhatsApp to ' + num, 'info');
  var result = await notify(num, 'whatsapp', '✅ WhatsApp test from ProbationCall!\n\nIf you see this, WhatsApp is working.', 'test');
  res.json(result);
});

app.post('/api/test-sms', auth, async function(req, res) {
  var num = req.body.notifyNumber;
  log('test', 'Testing SMS to ' + num, 'info');
  var result = await notify(num, 'sms', 'SMS test from ProbationCall! If you see this, SMS is working.', 'test');
  res.json(result);
});

wss.on('connection', function(ws, req) {
  if (req.url === '/ws') {
    console.log('[WS] Client connected');
    wsClients.add(ws);
    ws.on('close', function() { 
      console.log('[WS] Client disconnected');
      wsClients.delete(ws); 
    });
  }
});

var PORT = process.env.PORT || 3000;
server.listen(PORT, function() {
  console.log('========================================');
  console.log('ProbationCall Server Started');
  console.log('Port: ' + PORT);
  console.log('Base URL: ' + process.env.BASE_URL);
  console.log('Voice Number: ' + TWILIO_VOICE_NUMBER);
  console.log('SMS Number: ' + TWILIO_SMS_NUMBER);
  console.log('Dev Accounts: ' + DEV_EMAILS.join(', '));
  console.log('========================================');
  loadAllSchedules();
});

module.exports = app;

// Email notification fallback (using nodemailer)
const nodemailer = require('nodemailer');
const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function sendEmailNotification(email, result, pin) {
  try {
    var emoji = result === 'NO_TEST' ? '✅' : '🚨';
    var subject = emoji + ' Probation Call Result';
    var text = result === 'NO_TEST' 
      ? 'Good news! No test required today. PIN used: ' + pin
      : 'ALERT: Test required today! PIN used: ' + pin;
    
    await emailTransporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: subject,
      text: text
    });
    console.log('Email sent to ' + email);
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}
