require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const path = require('path');
const cron = require('node-cron');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DEV_EMAILS = ['whatnissan@gmail.com', 'whatnissan@protonmail.com'];

app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Gmail SMTP setup
let emailTransporter = null;
if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
  emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS
    }
  });
  console.log('[EMAIL] Gmail configured');
}

const pendingCalls = new Map();
const wsClients = new Set();
const scheduledJobs = new Map();

const TWILIO_VOICE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const MESSAGING_SERVICE_SID = 'MG8adbb793f6b8c100da6770f6f0707258';
const WHATSAPP_NUMBER = 'whatsapp:+14155238886';

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
  console.log('[' + (callId || 'SYS') + '] ' + msg);
  broadcastToClients({ type: 'log', callId: callId, log: { message: msg, type: type || 'info' } });
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
app.get('/health', function(req, res) { res.json({ status: 'ok' }); });

app.get('/api/user', auth, async function(req, res) {
  var historyResult = await supabase.from('call_history').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(30);
  var scheduleResult = await supabase.from('user_schedules').select('*').eq('user_id', req.user.id).single();
  res.json({ 
    user: req.user, 
    profile: req.profile, 
    history: historyResult.data || [], 
    schedule: scheduleResult.data,
    isDev: isDev(req.user.email)
  });
});

app.post('/api/redeem', auth, async function(req, res) {
  var code = req.body.code;
  if (!code) return res.status(400).json({ error: 'No code' });
  
  var promoResult = await supabase.from('promo_codes').select('*').eq('code', code.toUpperCase()).single();
  var promo = promoResult.data;
  if (!promo) return res.status(404).json({ error: 'Invalid code' });
  if (promo.times_used >= promo.max_uses) return res.status(400).json({ error: 'Code expired' });
  
  var existingResult = await supabase.from('promo_redemptions').select('*').eq('user_id', req.user.id).eq('promo_code_id', promo.id).single();
  if (existingResult.data) return res.status(400).json({ error: 'Already used' });
  
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
    notify_email: req.body.notifyEmail || null,
    notify_method: req.body.notifyMethod || 'email',
    hour: parseInt(req.body.hour) || 6,
    minute: parseInt(req.body.minute) || 0,
    timezone: req.body.timezone || 'America/Chicago',
    enabled: true,
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
  console.log('[SCHED] User ' + userId + ': ' + expr + ' ' + sched.timezone);
  
  var job = cron.schedule(expr, async function() {
    console.log('[SCHED] Running for ' + userId);
    try {
      var profileResult = await supabase.from('profiles').select('credits, email').eq('id', userId).single();
      var profile = profileResult.data;
      
      if (!profile) return;
      
      var isDevUser = isDev(profile.email);
      
      if (!isDevUser && profile.credits < 1) {
        await notify(sched.notify_number, sched.notify_email, sched.notify_method, 'ProbationCall: Scheduled call skipped - no credits!', 'sched');
        return;
      }
      
      await initiateCall(sched.target_number, sched.pin, sched.notify_number, sched.notify_email, sched.notify_method, userId);
      
      if (!isDevUser) {
        await supabase.from('profiles').update({ credits: profile.credits - 1 }).eq('id', userId);
      }
    } catch (e) {
      console.error('[SCHED] Error:', e);
      await notify(sched.notify_number, sched.notify_email, sched.notify_method, 'ProbationCall: Scheduled call failed!', 'sched');
    }
  }, { timezone: sched.timezone });
  
  scheduledJobs.set(userId, job);
}

async function loadAllSchedules() {
  var result = await supabase.from('user_schedules').select('*').eq('enabled', true);
  if (result.data && result.data.length > 0) {
    result.data.forEach(function(s) { rescheduleUser(s.user_id, s); });
    console.log('[SCHED] Loaded ' + result.data.length + ' schedules');
  }
}

app.post('/api/checkout', auth, async function(req, res) {
  var pkg = PACKAGES[req.body.packageId];
  if (!pkg) return res.status(400).json({ error: 'Invalid package' });
  
  var session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{ price_data: { currency: 'usd', product_data: { name: pkg.name + ' - ' + pkg.credits + ' Credits' }, unit_amount: pkg.price }, quantity: 1 }],
    mode: 'payment',
    success_url: process.env.BASE_URL + '/dashboard?success=true',
    cancel_url: process.env.BASE_URL + '/dashboard?canceled=true',
    metadata: { user_id: req.user.id, package_id: req.body.packageId, credits: String(pkg.credits) }
  });
  res.json({ url: session.url });
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
    await supabase.from('purchases').insert({ user_id: s.metadata.user_id, stripe_session_id: s.id, package_name: s.metadata.package_id, credits_purchased: parseInt(s.metadata.credits), amount_cents: s.amount_total });
  }
  res.json({ received: true });
});

app.post('/api/call', auth, async function(req, res) {
  if (!req.profile.isDev && req.profile.credits < 1) {
    return res.status(402).json({ error: 'No credits' });
  }
  
  var targetNumber = req.body.targetNumber;
  var pin = req.body.pin;
  var notifyNumber = req.body.notifyNumber;
  var notifyEmail = req.body.notifyEmail;
  var notifyMethod = req.body.notifyMethod || 'email';
  
  if (!targetNumber || !pin) return res.status(400).json({ error: 'Missing fields' });
  if (!/^\+\d{10,15}$/.test(targetNumber)) return res.status(400).json({ error: 'Invalid phone format' });
  if (pin.length !== 6 || !/^\d+$/.test(pin)) return res.status(400).json({ error: 'PIN must be 6 digits' });
  
  try {
    var result = await initiateCall(targetNumber, pin, notifyNumber, notifyEmail, notifyMethod, req.user.id);
    if (!req.profile.isDev) {
      await supabase.from('profiles').update({ credits: req.profile.credits - 1 }).eq('id', req.user.id);
    }
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

async function initiateCall(targetNumber, pin, notifyNumber, notifyEmail, notifyMethod, userId) {
  var callId = 'call_' + Date.now();
  log(callId, 'Starting call to ' + targetNumber, 'info');
  
  pendingCalls.set(callId, { 
    targetNumber: targetNumber, 
    pin: pin, 
    notifyNumber: notifyNumber,
    notifyEmail: notifyEmail,
    notifyMethod: notifyMethod,
    userId: userId, 
    result: null
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
  
  if (!config) { twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }
  
  log(callId, 'Call answered, sending DTMF', 'success');
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
  
  log(callId, 'Speech: "' + speech + '"', 'info');
  
  if (config && !config.result) {
    var lower = speech.toLowerCase();
    var result = 'UNKNOWN';
    
    if (KEYWORDS.MUST_TEST.some(function(k) { return lower.indexOf(k) >= 0; })) {
      result = 'MUST_TEST';
      log(callId, 'RESULT: TEST REQUIRED!', 'warning');
    } else if (KEYWORDS.NO_TEST.some(function(k) { return lower.indexOf(k) >= 0; })) {
      result = 'NO_TEST';
      log(callId, 'RESULT: No test', 'success');
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
    
    await notify(config.notifyNumber, config.notifyEmail, config.notifyMethod, message, callId);
    
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
    await notify(config.notifyNumber, config.notifyEmail, config.notifyMethod, '⚠️ Call completed but no result detected.\n\nPlease verify manually.\nPIN: ' + config.pin, callId);
    if (config.userId) {
      await supabase.from('call_history').insert({ user_id: config.userId, call_sid: config.callSid, target_number: config.targetNumber, pin_used: config.pin, result: 'UNKNOWN' });
    }
    broadcastToClients({ type: 'result', callId: callId, result: 'UNKNOWN', speech: '' });
  }
  
  var twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

app.post('/webhook/status', function(req, res) {
  var callId = req.query.callId;
  log(callId, 'Status: ' + req.body.CallStatus, 'info');
  var config = pendingCalls.get(callId);
  if (config) {
    config.status = req.body.CallStatus;
    broadcastToClients({ type: 'status', callId: callId, status: req.body.CallStatus });
  }
  res.sendStatus(200);
});

// NOTIFICATION FUNCTIONS
async function notify(phone, email, method, message, callId) {
  log(callId, 'Notifying via ' + method, 'info');
  
  if (method === 'email' && email) {
    return await sendEmail(email, message, callId);
  }
  if (method === 'sms' && phone) {
    return await sendSMS(phone, message, callId);
  }
  if (method === 'whatsapp' && phone) {
    return await sendWhatsApp(phone, message, callId);
  }
  
  log(callId, 'No valid notification method', 'error');
  return { success: false, error: 'No notification method' };
}

async function sendEmail(to, message, callId) {
  if (!emailTransporter) {
    log(callId, 'Email not configured', 'error');
    return { success: false, error: 'Email not configured' };
  }
  
  var subject = 'ProbationCall Alert';
  if (message.includes('TEST REQUIRED')) {
    subject = '🚨 TEST REQUIRED - ProbationCall';
  } else if (message.includes('No test today')) {
    subject = '✅ No Test Today - ProbationCall';
  }
  
  try {
    await emailTransporter.sendMail({
      from: '"ProbationCall" <' + process.env.GMAIL_USER + '>',
      to: to,
      subject: subject,
      text: message,
      html: '<div style="font-family:sans-serif;padding:20px;max-width:400px;margin:0 auto;">' +
            '<h2 style="color:#00d9ff;">ProbationCall</h2>' +
            '<div style="background:#f5f5f5;padding:20px;border-radius:10px;white-space:pre-line;">' + message + '</div>' +
            '</div>'
    });
    log(callId, 'Email sent to ' + to, 'success');
    return { success: true };
  } catch (e) {
    log(callId, 'Email failed: ' + e.message, 'error');
    return { success: false, error: e.message };
  }
}

async function sendSMS(to, message, callId) {
  try {
    var msg = await twilioClient.messages.create({ 
      messagingServiceSid: MESSAGING_SERVICE_SID, 
      to: to, 
      body: message 
    });
    log(callId, 'SMS sent: ' + msg.sid, 'success');
    return { success: true, sid: msg.sid };
  } catch (e) {
    log(callId, 'SMS failed: ' + e.message, 'error');
    return { success: false, error: e.message };
  }
}

async function sendWhatsApp(to, message, callId) {
  var toWA = to.indexOf('whatsapp:') === 0 ? to : 'whatsapp:' + to;
  try {
    var msg = await twilioClient.messages.create({ from: WHATSAPP_NUMBER, to: toWA, body: message });
    log(callId, 'WhatsApp sent: ' + msg.sid, 'success');
    return { success: true, sid: msg.sid };
  } catch (e) {
    log(callId, 'WhatsApp failed: ' + e.message, 'error');
    return { success: false, error: e.message };
  }
}

// Test endpoints
app.post('/api/test-email', auth, async function(req, res) {
  var result = await sendEmail(req.body.email, '✅ Test email from ProbationCall!\n\nIf you see this, email notifications are working.', 'test');
  res.json(result);
});

app.post('/api/test-sms', auth, async function(req, res) {
  var result = await sendSMS(req.body.notifyNumber, 'Test SMS from ProbationCall!', 'test');
  res.json(result);
});

app.post('/api/test-whatsapp', auth, async function(req, res) {
  var result = await sendWhatsApp(req.body.notifyNumber, '✅ Test WhatsApp from ProbationCall!', 'test');
  res.json(result);
});

wss.on('connection', function(ws, req) {
  if (req.url === '/ws') {
    wsClients.add(ws);
    ws.on('close', function() { wsClients.delete(ws); });
  }
});

var PORT = process.env.PORT || 3000;
server.listen(PORT, function() {
  console.log('========================================');
  console.log('ProbationCall Server Running');
  console.log('Port: ' + PORT);
  console.log('Voice: ' + TWILIO_VOICE_NUMBER);
  console.log('Email: ' + (emailTransporter ? 'Gmail configured' : 'Not configured'));
  console.log('========================================');
  loadAllSchedules();
});

module.exports = app;
