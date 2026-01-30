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

// --- BREVO EMAIL CONFIGURATION ---
const brevoTransporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  secure: false, // Critical for Port 587 to prevent hanging
  auth: {
    user: process.env.BREVO_USER,
    pass: process.env.BREVO_KEY
  },
  tls: {
    rejectUnauthorized: false // Helps prevent handshake errors
  },
  connectionTimeout: 10000, // Throw error after 10 seconds instead of hanging
  logger: true, // Log details to console
  debug: true
});

// Shim to make Brevo compatible with your existing code
const sgMail = {
  setApiKey: () => {}, 
  send: async (msg) => {
    try {
      console.log('Sending email via Brevo to:', msg.to);
      await brevoTransporter.sendMail({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html || msg.text,
      });
      console.log('✅ Email sent successfully');
    } catch (error) {
      console.error('❌ Brevo Error:', error);
    }
  }
};
// ---------------------------------


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

if (process.env.BREVO_KEY) {
  sgMail.setApiKey(process.env.BREVO_KEY);
  console.log('[EMAIL] SendGrid configured');
}

const pendingCalls = new Map();
const wsClients = new Set();
const scheduledJobs = new Map();

const TWILIO_VOICE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const MESSAGING_SERVICE_SID = 'MG8adbb793f6b8c100da6770f6f0707258';
const WHATSAPP_NUMBER = 'whatsapp:+15558965863';
const FROM_EMAIL = 'alerts@probationcall.com';

// Time restrictions: 6:00 AM to 2:59 PM
const MIN_HOUR = 6;
const MAX_HOUR = 14;

// Stagger calls over this many minutes to prevent server overload
const STAGGER_MINUTES = 15;

// Supported Counties Configuration
const COUNTIES = {
  'montgomery': {
    name: 'Montgomery County',
    number: '+19362834848',
    process: 'standard',
    minHour: 6,
    maxHour: 14
  },
  'ftbend': {
    name: 'Fort Bend County',
    number: '+12812383668',
    process: 'color',
    minHour: 5,
    maxHour: 9
  }
};

// Fort Bend Offices (3 locations)
const FTBEND_OFFICES = {
  'missouri': { 
    name: 'Missouri City', 
    number: '+12812383668',
    label: 'Missouri City'
  },
  'rosenberg': { 
    name: 'Rosenberg', 
    number: '+12812383669',
    label: 'Rosenberg'
  },
  'rosenberg2': { 
    name: 'Rosenberg 2', 
    number: '+12812383671',
    label: 'Rosenberg Phase',
    hasPhases: true
  }
};

// Fort Bend County colors for detection
const FTBEND_COLORS = [
  'amber', 'apricot', 'aqua', 'auburn', 'beaver', 'black', 'blue', 'brown', 'burgundy',
  'bronze', 'canary', 'tan', 'cherry', 'chestnut', 'coral', 'copper', 'cream', 'crimson', 'cyan',
  'emerald', 'forest', 'fuchsia', 'gold', 'gray', 'grey', 'green',
  'ivory', 'jade', 'lavender', 'lemon', 'lilac', 'lime', 'magenta', 'maroon',
  'navy', 'olive', 'orange', 'orchid', 'peach', 'pearl', 'pink', 'plum', 'purple',
  'red', 'rose', 'ruby', 'rust', 'salmon', 'sapphire', 'scarlet', 'silver',
  'tan', 'teal', 'turquoise', 'violet', 'white', 'wine', 'yellow',
  'gray', 'lemon', 'prep', 'phase 1', 'phase 1 a', 'phase 1 b', 'phase 2', 'phase 3', 'phase 4'
];

function detectColor(transcript) {
  var lower = transcript.toLowerCase();
  console.log('[FTBEND] Analyzing: "' + lower + '"');
  
  // FIRST - check known colors (most reliable)
  for (var i = 0; i < FTBEND_COLORS.length; i++) {
    // Use word boundary check to avoid partial matches
    var colorRegex = new RegExp('\\b' + FTBEND_COLORS[i] + '\\b', 'i');
    if (colorRegex.test(lower)) {
      console.log('[FTBEND] Known color found: ' + FTBEND_COLORS[i]);
      return FTBEND_COLORS[i].charAt(0).toUpperCase() + FTBEND_COLORS[i].slice(1);
    }
  }
  
  // Try to extract color from patterns like "color is X"
  var patterns = [
    /color\s+(?:is|for today is|today is|will be)\s+([a-z]+)/i,
    /today(?:'s)?\s+color\s+(?:is\s+)?([a-z]+)/i,
    /the\s+color\s+(?:is\s+)?([a-z]+)/i
  ];
  
  for (var p = 0; p < patterns.length; p++) {
    var match = lower.match(patterns[p]);
    if (match && match[1]) {
      var extracted = match[1].trim();
      if (['the', 'a', 'is', 'for', 'to', 'and', 'hot', 'call'].indexOf(extracted) === -1) {
        console.log('[FTBEND] Pattern found: ' + extracted);
        return extracted.charAt(0).toUpperCase() + extracted.slice(1);
      }
    }
  }
  
  // Only very specific misrecognitions (avoid false positives)
  var fixes = {
    'can airy': 'canary', 'canaries': 'canary', 'canari': 'canary',
    'all of ': 'olive', 'all live': 'olive', 
    'i very': 'ivory', 'i vory': 'ivory',
    'grey': 'gray',
    'can': 'cyan', 'cyn': 'cyan', 'ten': 'tan', 'dan': 'tan', 'pan': 'tan', 'tin': 'tan', 'ton': 'tan', 'hand': 'tan', 'man': 'tan', 'fan': 'tan', 'tanned': 'tan', 'tent': 'tan', 'zion': 'cyan', 'sign': 'cyan',
    'sigh in': 'cyan', 'sigh an': 'cyan', 'sy an': 'cyan', 'psy an': 'cyan', 'sign': 'cyan'
  };
  
  for (var fix in fixes) {
    if (lower.includes(fix)) {
      console.log('[FTBEND] Misrecognition fix: ' + fix + ' -> ' + fixes[fix]);
      return fixes[fix].charAt(0).toUpperCase() + fixes[fix].slice(1);
    }
  }
  
  // Last resort - find word after "is" or "color"
  var afterIs = lower.match(/(?:is|color)\s+([a-z]{3,})/);
  if (afterIs && afterIs[1]) {
    var word = afterIs[1];
    if (['the', 'for', 'today', 'your', 'you', 'hot', 'call'].indexOf(word) === -1) {
      console.log('[FTBEND] Word after is/color: ' + word);
      return word.charAt(0).toUpperCase() + word.slice(1);
    }
  }
  
  return null;
}

function getCountyConfig(countyId) {
  return COUNTIES[countyId] || COUNTIES['montgomery'];
}



// Affiliate settings
const AFFILIATE_COMMISSION_PERCENT = 30;

// Format phone to E.164 (+1XXXXXXXXXX)
function formatPhone(phone) {
  if (!phone) return phone;
  var cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.length === 10) cleaned = '1' + cleaned;
  if (cleaned.length === 11 && cleaned[0] === '1') {
    return '+' + cleaned;
  }
  return phone.startsWith('+') ? phone : '+' + cleaned;
} // 30% commission
const MIN_PAYOUT_CENTS = 2000; // $20 minimum payout
const REFERRED_BONUS_CREDITS = 5; // Bonus credits for new users who use referral

const PACKAGES = {
  starter: { name: 'Starter', credits: 30, price: 1499 },
  standard: { name: 'Standard', credits: 90, price: 3999 },
  value: { name: 'Value', credits: 180, price: 6999 }
};

const KEYWORDS = {
  NO_TEST: ['do not test', 'not required', 'no need', 'you do not', 'do not need', 'not test'],
  MUST_TEST: ['required to test', 'must test', 'you are required', 'report for', 'required today']
};

function isDev(email) {
  return DEV_EMAILS.includes(email.toLowerCase());
}

function generateReferralCode() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var code = '';
  for (var i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
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

// Generate consistent random delay based on user ID (same user = same delay each day)
function getStaggerDelay(userId) {
  var hash = 0;
  for (var i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i);
    hash = hash & hash;
  }
  // Convert to 0 to STAGGER_MINUTES range (in milliseconds)
  var delayMs = Math.abs(hash % (STAGGER_MINUTES * 60 * 1000));
  return delayMs;
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
      var referralCode = generateReferralCode();
      var startCredits = isDev(user.email) ? 9999 : 1;
      await supabase.from('profiles').insert({ 
        id: user.id, 
        email: user.email, 
        credits: startCredits,
        referral_code: referralCode,
        affiliate_balance_cents: 0,
        affiliate_total_earned_cents: 0
      });
      profile = { id: user.id, email: user.email, credits: startCredits, referral_code: referralCode };
    }
    
    // Generate referral code if user doesn't have one
    if (!profile.referral_code) {
      var newCode = generateReferralCode();
      await supabase.from('profiles').update({ referral_code: newCode }).eq('id', user.id);
      profile.referral_code = newCode;
    }
    
    if (isDev(user.email)) {
      profile.credits = 9999;
      profile.isDev = true;
    }
    
    req.user = user;
    req.profile = profile;
    // Track last login
    supabase.from('profiles').update({ last_login: new Date().toISOString() }).eq('id', user.id);
    next();
  } catch(e) {
    console.error('Auth error:', e);
    res.status(500).json({ error: 'Auth error' });
  }
}

app.get('/', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/login', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/dashboard', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/health', function(req, res) { res.json({ status: 'ok', scheduledJobs: scheduledJobs.size, activeConnections: wsClients.size }); });

// Referral landing page
app.get('/r/:code', function(req, res) {
  res.redirect('/?ref=' + req.params.code);
});

app.get('/api/user', auth, async function(req, res) {
  var historyResult = await supabase.from('call_history').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(500);
  var scheduleResult = await supabase.from('user_schedules').select('*').eq('user_id', req.user.id).single();
  
  // Get referral stats
  var referralResult = await supabase.from('referrals').select('*').eq('referrer_id', req.user.id);
  var referrals = referralResult.data || [];
  
  // Get earnings history
  var earningsResult = await supabase.from('affiliate_earnings').select('*').eq('affiliate_id', req.user.id).order('created_at', { ascending: false }).limit(20);
  
  // Get payout history
  var payoutsResult = await supabase.from('payout_requests').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(10);
  
  res.json({ 
    user: req.user, 
    profile: req.profile,
    probationEndDate: req.profile.probation_end_date,
    userColor: req.profile.user_color,
    onboardingComplete: req.profile.onboarding_complete,
    ftbend_access: req.profile.ftbend_access || false,
    history: historyResult.data || [], 
    schedule: scheduleResult.data,
    isDev: isDev(req.user.email),
    affiliate: {
      referralCode: req.profile.referral_code,
      balance: req.profile.affiliate_balance_cents || 0,
      totalEarned: req.profile.affiliate_total_earned_cents || 0,
      minPayout: MIN_PAYOUT_CENTS,
      commissionPercent: AFFILIATE_COMMISSION_PERCENT,
      referrals: referrals,
      earnings: earningsResult.data || [],
      payouts: payoutsResult.data || [],
      payoutEmail: req.profile.payout_email
    }
  });
});

// Global Montgomery Test Analytics (for learning patterns)
app.get("/api/admin/montgomery-analytics", adminAuth, async function(req, res) {
  try {
    var result = await supabase.from("call_history").select("*").eq("result", "MUST_TEST").order("created_at", { ascending: true });
    if (result.error) return res.status(500).json({ error: result.error.message });
    var tests = result.data || [];
    if (tests.length < 5) return res.json({ error: "Not enough data", totalTests: tests.length });
    
    // Calculate system-wide interval
    var userTests = {};
    tests.forEach(function(t) {
      if (!userTests[t.user_id]) userTests[t.user_id] = [];
      userTests[t.user_id].push(new Date(t.created_at));
    });
    
    var allIntervals = [];
    Object.keys(userTests).forEach(function(uid) {
      var dates = userTests[uid].sort(function(a,b) { return a-b; });
      for (var i = 1; i < dates.length; i++) {
        var days = Math.round((dates[i] - dates[i-1]) / (1000*60*60*24));
        if (days > 0 && days < 60) allIntervals.push(days);
      }
    });
    
    var avgSystemInterval = allIntervals.length > 0 ? (allIntervals.reduce(function(a,b){return a+b},0) / allIntervals.length) : 0;
    var medianInterval = allIntervals.sort(function(a,b){return a-b})[Math.floor(allIntervals.length/2)] || 0;
    
    // Day of week analysis
    var dayCount = [0,0,0,0,0,0,0];
    var dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    tests.forEach(function(t) { dayCount[new Date(t.created_at).getDay()]++; });
    var maxDay = Math.max.apply(null, dayCount);
    var dayPatterns = dayNames.map(function(name, i) {
      return { day: name, count: dayCount[i], pct: ((dayCount[i]/tests.length)*100).toFixed(1), likelihood: dayCount[i] >= maxDay*0.7 ? "high" : dayCount[i] >= maxDay*0.3 ? "medium" : "low" };
    });
    
    // Day of month analysis
    var domCount = {};
    tests.forEach(function(t) {
      var dom = new Date(t.created_at).getDate();
      domCount[dom] = (domCount[dom] || 0) + 1;
    });
    var domPatterns = Object.keys(domCount).map(function(d) { return { day: parseInt(d), count: domCount[d] }; }).sort(function(a,b) { return b.count - a.count; });
    
    // Week of month analysis
    var weekCount = [0,0,0,0,0];
    tests.forEach(function(t) {
      var dom = new Date(t.created_at).getDate();
      var week = Math.min(4, Math.floor((dom-1)/7));
      weekCount[week]++;
    });
    var weekLabels = ["Week 1 (1-7)","Week 2 (8-14)","Week 3 (15-21)","Week 4 (22-28)","Week 5 (29-31)"];
    var weekPatterns = weekLabels.map(function(label, i) { return { week: label, count: weekCount[i], pct: ((weekCount[i]/tests.length)*100).toFixed(1) }; });
    
    // Consecutive test analysis
    var consecutiveCount = 0;
    var userConsec = {};
    Object.keys(userTests).forEach(function(uid) {
      var dates = userTests[uid].sort(function(a,b){return a-b});
      for (var i = 1; i < dates.length; i++) {
        var days = Math.round((dates[i] - dates[i-1]) / (1000*60*60*24));
        if (days <= 2) consecutiveCount++;
      }
    });
    var consecPct = allIntervals.length > 0 ? ((consecutiveCount/allIntervals.length)*100).toFixed(1) : 0;
    
    // Interval distribution
    var intervalDist = {};
    allIntervals.forEach(function(i) { intervalDist[i] = (intervalDist[i] || 0) + 1; });
    var topIntervals = Object.keys(intervalDist).map(function(i) { return { days: parseInt(i), count: intervalDist[i] }; }).sort(function(a,b) { return b.count - a.count; }).slice(0, 10);
    
    res.json({
      totalTests: tests.length,
      totalUsers: Object.keys(userTests).length,
      avgSystemInterval: avgSystemInterval.toFixed(1),
      medianInterval: medianInterval,
      dayPatterns: dayPatterns,
      weekPatterns: weekPatterns,
      topDaysOfMonth: domPatterns.slice(0, 10),
      consecutiveTestPct: consecPct,
      topIntervals: topIntervals,
      confidence: Math.min(95, 50 + tests.length)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Fort Bend Color Analytics
app.get("/api/ftbend/analytics", auth, async function(req, res) {
  try {
    var result = await supabase.from("daily_county_status").select("*").order("date", { ascending: false }).limit(365);
    if (result.error) return res.status(500).json({ error: result.error.message });
    var data = result.data || [];
    var colorCounts = {};
    var dayOfWeekCounts = {};
    var officeColors = { missouri: {}, rosenberg: {}, rosenberg2: {} };
    var recentColors = { missouri: [], rosenberg: [], rosenberg2: [] };
    var dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    data.forEach(function(r) {
      if (!r.color) return;
      var color = r.color.toLowerCase();
      colorCounts[color] = (colorCounts[color] || 0) + 1;
      var dow = new Date(r.date).getDay();
      if (!dayOfWeekCounts[dow]) dayOfWeekCounts[dow] = {};
      dayOfWeekCounts[dow][color] = (dayOfWeekCounts[dow][color] || 0) + 1;
      var office = r.county ? r.county.replace("ftbend_", "") : "missouri";
      if (officeColors[office]) {
        officeColors[office][color] = (officeColors[office][color] || 0) + 1;
        if (recentColors[office].length < 30) recentColors[office].push({ date: r.date, color: r.color });
      }
    });
    var sortedColors = Object.keys(colorCounts).sort(function(a, b) { return colorCounts[b] - colorCounts[a]; });
    var topColors = sortedColors.slice(0, 15).map(function(c) { return { color: c, count: colorCounts[c], pct: ((colorCounts[c] / data.length) * 100).toFixed(1) }; });
    var dayPatterns = {};
    for (var d = 0; d < 7; d++) {
      if (dayOfWeekCounts[d]) {
        var sorted = Object.keys(dayOfWeekCounts[d]).sort(function(a, b) { return dayOfWeekCounts[d][b] - dayOfWeekCounts[d][a]; });
        dayPatterns[dayNames[d]] = sorted.slice(0, 5).map(function(c) { return { color: c, count: dayOfWeekCounts[d][c] }; });
      }
    }
    var lastCalled = {};
    data.forEach(function(r) {
      if (r.color && !lastCalled[r.color.toLowerCase()]) lastCalled[r.color.toLowerCase()] = r.date;
    });
    var predictions = sortedColors.slice(0, 20).map(function(c) {
      var lastDate = lastCalled[c];
      var daysSince = lastDate ? Math.round((new Date() - new Date(lastDate)) / (1000 * 60 * 60 * 24)) : 999;
      var avgInterval = data.length > 0 ? Math.round(data.length / (colorCounts[c] || 1)) : 0;
      return { color: c, count: colorCounts[c], daysSince: daysSince, avgInterval: avgInterval, likelihood: daysSince >= avgInterval ? "high" : daysSince >= avgInterval * 0.7 ? "medium" : "low" };
    });
    res.json({ totalRecords: data.length, topColors: topColors, dayPatterns: dayPatterns, predictions: predictions, recentColors: recentColors, officeColors: officeColors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Apply referral code (called during signup or first visit)
app.post('/api/apply-referral', auth, async function(req, res) {
  var code = req.body.code;
  if (!code) return res.status(400).json({ error: 'No code provided' });
  
  // Check if user already used a referral
  if (req.profile.referred_by) {
    return res.status(400).json({ error: 'You already used a referral code' });
  }
  
  // Find referrer
  var referrerResult = await supabase.from('profiles').select('id, email').eq('referral_code', code.toUpperCase()).single();
  if (!referrerResult.data) {
    return res.status(404).json({ error: 'Invalid referral code' });
  }
  
  // Can't refer yourself
  if (referrerResult.data.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot use your own referral code' });
  }
  
  // Update referred user with bonus credits
  await supabase.from('profiles').update({ 
    referred_by: code.toUpperCase(),
    credits: req.profile.credits + REFERRED_BONUS_CREDITS
  }).eq('id', req.user.id);
  
  // Create referral record
  await supabase.from('referrals').insert({
    referrer_id: referrerResult.data.id,
    referred_id: req.user.id,
    referral_code: code.toUpperCase(),
    status: 'signed_up'
  });
  
  console.log('[AFFILIATE] User ' + req.user.email + ' signed up with code ' + code);
  
  res.json({ success: true, bonusCredits: REFERRED_BONUS_CREDITS });
});

// Set payout email
app.post('/api/affiliate/payout-email', auth, async function(req, res) {
  var email = req.body.email;
  if (!email) return res.status(400).json({ error: 'Email required' });
  
  await supabase.from('profiles').update({ payout_email: email }).eq('id', req.user.id);
  res.json({ success: true });
});

// Request payout
app.post('/api/affiliate/request-payout', auth, async function(req, res) {
  var balance = req.profile.affiliate_balance_cents || 0;
  var payoutEmail = req.profile.payout_email;
  var method = req.body.method || 'paypal';
  
  if (!payoutEmail) {
    return res.status(400).json({ error: 'Please set your PayPal email first' });
  }
  
  if (balance < MIN_PAYOUT_CENTS) {
    return res.status(400).json({ error: 'Minimum payout is $' + (MIN_PAYOUT_CENTS / 100).toFixed(2) });
  }
  
  // Check for pending payout
  var pendingResult = await supabase.from('payout_requests').select('id').eq('user_id', req.user.id).eq('status', 'pending').single();
  if (pendingResult.data) {
    return res.status(400).json({ error: 'You already have a pending payout request' });
  }
  
  // Create payout request
  await supabase.from('payout_requests').insert({
    user_id: req.user.id,
    amount_cents: balance,
    payout_email: payoutEmail,
    payout_method: method,
    status: 'pending'
  });
  
  // Reset balance to 0 (moved to pending)
  await supabase.from('profiles').update({ affiliate_balance_cents: 0 }).eq('id', req.user.id);
  
  // Notify you (the owner) about payout request
  if (process.env.BREVO_KEY) {
    await sgMail.send({
      to: 'whatnissan@gmail.com',
      from: FROM_EMAIL,
      subject: '💰 New Payout Request - ProbationCall',
      text: 'New payout request:\n\nUser: ' + req.user.email + '\nAmount: $' + (balance / 100).toFixed(2) + '\nPayPal: ' + payoutEmail
    });
  }
  
  console.log('[AFFILIATE] Payout requested: $' + (balance / 100).toFixed(2) + ' to ' + payoutEmail);
  
  res.json({ success: true, amount: balance });
});

app.post("/api/accept-terms", auth, async function(req, res) { 
  try { 
    var result = await supabase.from("profiles").update({ terms_accepted_at: new Date().toISOString() }).eq("id", req.user.id);
    if (result.error) {
      console.error('[TERMS] Error:', result.error);
      return res.status(500).json({ error: result.error.message }); 
    }
    res.json({ success: true }); 
  } catch (e) { 
    console.error('[TERMS] Exception:', e);
    res.status(500).json({ error: e.message }); 
  } 
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

// Check if affiliate code is valid
app.post('/api/check-affiliate-code', auth, async function(req, res) {
  var code = req.body.code ? req.body.code.toUpperCase() : '';
  
  var result = await supabase.from('profiles')
    .select('id, referral_code')
    .eq('referral_code', code)
    .single();
  
  if (result.data) {
    res.json({ valid: true, code: code });
  } else {
    res.json({ valid: false });
  }
});

// Stripe Connect - Create onboarding link for affiliates
app.post('/api/affiliate/connect', auth, async function(req, res) {
  try {
    // Check if user already has a connected account
    if (req.profile.stripe_connect_id) {
      // Create login link for existing account
      var loginLink = await stripe.accounts.createLoginLink(req.profile.stripe_connect_id);
      return res.json({ url: loginLink.url });
    }
    
    // Create new connected account
    var account = await stripe.accounts.create({
      type: 'standard',
      email: req.user.email,
      metadata: { user_id: req.user.id }
    });
    
    // Save the account ID
    await supabase.from('profiles')
      .update({ stripe_connect_id: account.id })
      .eq('id', req.user.id);
    
    // Create onboarding link
    var accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: process.env.BASE_URL + '/dashboard?connect=refresh',
      return_url: process.env.BASE_URL + '/dashboard?connect=success',
      type: 'account_onboarding'
    });
    
    console.log('[CONNECT] Created account for ' + req.user.email + ': ' + account.id);
    res.json({ url: accountLink.url });
  } catch (e) {
    console.error('[CONNECT] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Check Stripe Connect status
app.get('/api/affiliate/connect-status', auth, async function(req, res) {
  if (!req.profile.stripe_connect_id) {
    return res.json({ connected: false });
  }
  
  try {
    var account = await stripe.accounts.retrieve(req.profile.stripe_connect_id);
    res.json({ 
      connected: true, 
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      account_id: account.id
    });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

app.post('/api/schedule', auth, async function(req, res) {
  var hour = parseInt(req.body.hour) || 6;
  var minute = parseInt(req.body.minute) || 0;
  
  var county = req.body.county || 'montgomery';
  
  // Fort Bend has different time restrictions
  if (county !== 'ftbend' && (hour < MIN_HOUR || hour > MAX_HOUR || (hour === MAX_HOUR && minute > 59))) {
    return res.status(400).json({ error: 'Schedule time must be between 6:00 AM and 2:59 PM' });
  }
  
  var data = {
    user_id: req.user.id,
    county: req.body.county || 'montgomery',
    target_number: getCountyConfig(req.body.county || 'montgomery').number,
    pin: req.body.pin,
    notify_number: formatPhone(req.body.notifyNumber),
    notify_email: req.body.notifyEmail || null,
    notify_method: req.body.notifyMethod || 'email',
    hour: hour,
    minute: minute,
    timezone: req.body.timezone || 'America/Chicago',
    retry_on_unknown: req.body.retryOnUnknown || false,
    quiet_mode: req.body.quietMode || false,
    ftbend_office: req.body.ftbend_office || 'missouri',
    enabled: true,
    
  };
  
  var existingResult = await supabase.from('user_schedules').select('id').eq('user_id', req.user.id).single();
  
  var result;
  if (existingResult.data) {
    result = await supabase.from('user_schedules').update(data).eq('user_id', req.user.id);
  } else {
    result = await supabase.from('user_schedules').insert(data);
  }
  
  if (result.error) {
    console.error('[SCHEDULE] Error:', result.error);
    return res.status(500).json({ error: result.error.message || 'Database error' });
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
  
  // Ft Bend users don't get individual calls - they get notified by the 5:05 AM system call
  if (sched.county === 'ftbend') {
    console.log('[SCHED] User ' + userId.slice(0,8) + '... is Ft Bend - will be notified by system call');
    return;
  }
  
  var expr = sched.minute + ' ' + sched.hour + ' * * *';
  var staggerDelay = getStaggerDelay(userId);
  var staggerMinutes = Math.floor(staggerDelay / 60000);
  var staggerSeconds = Math.floor((staggerDelay % 60000) / 1000);
  
  console.log('[SCHED] User ' + userId.slice(0,8) + '...: ' + expr + ' ' + sched.timezone + 
    ' (stagger: +' + staggerMinutes + 'm ' + staggerSeconds + 's)' +
    (sched.retry_on_unknown ? ' [retry enabled]' : ''));
  
  var job = cron.schedule(expr, async function() {
    // Apply stagger delay to spread out calls
    setTimeout(async function() {
      console.log('[SCHED] Running for ' + userId.slice(0,8) + '... (after ' + staggerMinutes + 'm stagger)');
      try {
        var profileResult = await supabase.from('profiles').select('credits, email').eq('id', userId).single();
        var profile = profileResult.data;
        
        if (!profile) return;
        
        var isDevUser = isDev(profile.email);
        
        if (!isDevUser && profile.credits < 1) {
          var skipCount = (sched.no_credit_skip_count || 0) + 1;
          if (skipCount >= 2) {
            await supabase.from('user_schedules').delete().eq('user_id', userId);
            if (scheduledJobs.has(userId)) { scheduledJobs.get(userId).stop(); scheduledJobs.delete(userId); }
            await notify(sched.notify_number, sched.notify_email, sched.notify_method, 'ProbationCall: Your schedule has been removed due to no credits. Please log in, purchase credits, and set up your schedule again at probationcall.com', 'sched');
          } else {
            await supabase.from('user_schedules').update({ no_credit_skip_count: skipCount }).eq('user_id', userId);
            await notify(sched.notify_number, sched.notify_email, sched.notify_method, 'ProbationCall: Your scheduled call was skipped due to insufficient credits. Please log in and purchase credits at probationcall.com to continue service. Your schedule will be removed tomorrow if credits are not added.', 'sched');
          }

          return;
        }
        
        await initiateCall(sched.target_number, sched.pin, sched.notify_number, sched.notify_email, sched.notify_method, userId, sched.retry_on_unknown, 0);
        
        if (!isDevUser) {
          await supabase.from('profiles').update({ credits: profile.credits - 1 }).eq('id', userId); await supabase.from('user_schedules').update({ no_credit_skip_count: 0 }).eq('user_id', userId);
        }
      } catch (e) {
        console.error('[SCHED] Error for ' + userId.slice(0,8) + '...:', e.message);
        await notify(sched.notify_number, sched.notify_email, sched.notify_method, 'ProbationCall: Scheduled call failed!', 'sched');
      }
    }, staggerDelay);
  }, { timezone: sched.timezone });
  
  scheduledJobs.set(userId, job);
}

async function loadAllSchedules() {
  var result = await supabase.from('user_schedules').select('*').eq('enabled', true);
  if (result.data && result.data.length > 0) {
    result.data.forEach(function(s) { rescheduleUser(s.user_id, s); });
    console.log('[SCHED] Loaded ' + result.data.length + ' schedules (staggered over ' + STAGGER_MINUTES + ' minutes)');
  }
}

app.post('/api/checkout', auth, async function(req, res) {
  var pkg = PACKAGES[req.body.packageId];
  if (!pkg) return res.status(400).json({ error: 'Invalid package' });
  
  // Check for affiliate/promo code
  var affiliateCode = req.body.affiliateCode ? req.body.affiliateCode.toUpperCase() : null;
  var affiliateId = null;
  
  if (affiliateCode) {
    // Look up affiliate by their referral code
    var affiliateResult = await supabase.from('profiles')
      .select('id')
      .eq('referral_code', affiliateCode)
      .single();
    
    if (affiliateResult.data) {
      affiliateId = affiliateResult.data.id;
      console.log('[CHECKOUT] Affiliate code ' + affiliateCode + ' found: ' + affiliateId.slice(0,8));
      
      // Lock this user to the affiliate if not already locked
      if (!req.profile.referred_by) {
        await supabase.from('profiles')
          .update({ referred_by: affiliateCode })
          .eq('id', req.user.id);
        console.log('[CHECKOUT] Locked user ' + req.user.id.slice(0,8) + ' to affiliate ' + affiliateCode);
      }
    } else {
      console.log('[CHECKOUT] Affiliate code ' + affiliateCode + ' not found');
    }
  }
  
  var session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{ price_data: { currency: 'usd', product_data: { name: pkg.name + ' - ' + pkg.credits + ' Credits' }, unit_amount: pkg.price }, quantity: 1 }],
    mode: 'payment',
    success_url: process.env.BASE_URL + '/dashboard?success=true',
    cancel_url: process.env.BASE_URL + '/dashboard?canceled=true',
    metadata: { 
      user_id: req.user.id, 
      package_id: req.body.packageId, 
      credits: String(pkg.credits),
      affiliate_code: affiliateCode || '',
      affiliate_id: affiliateId || ''
    }
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
    var profileResult = await supabase.from('profiles').select('*').eq('id', s.metadata.user_id).single();
    var profile = profileResult.data;
    var currentCredits = profile ? profile.credits : 0;
    
    await supabase.from('profiles').update({ credits: currentCredits + parseInt(s.metadata.credits) }).eq('id', s.metadata.user_id);
    
    var purchaseResult = await supabase.from('purchases').insert({ 
      user_id: s.metadata.user_id, 
      stripe_session_id: s.id, 
      package_name: s.metadata.package_id, 
      credits_purchased: parseInt(s.metadata.credits), 
      amount_cents: s.amount_total 
    }).select().single();
    
    // AFFILIATE COMMISSION - check for checkout promo code OR previous referral
    var affiliateId = s.metadata.affiliate_id || null;
    var affiliateCode = s.metadata.affiliate_code || null;
    
    // If no checkout code, check if user was previously referred
    if (!affiliateId && profile && profile.referred_by) {
      affiliateCode = profile.referred_by;
      var refResult = await supabase.from('profiles')
        .select('id')
        .eq('referral_code', profile.referred_by)
        .single();
      if (refResult.data) affiliateId = refResult.data.id;
    }
    
    if (affiliateId) {
      var referrerResult = await supabase.from('profiles')
        .select('id, affiliate_balance_cents, affiliate_total_earned_cents, stripe_connect_id')
        .eq('id', affiliateId)
        .single();
      
      if (referrerResult.data) {
        // Calculate commission (30% of sale)
        var commission = Math.floor(s.amount_total * AFFILIATE_COMMISSION_PERCENT / 100);
        
        // Update referrer's balance
        var newBalance = (referrerResult.data.affiliate_balance_cents || 0) + commission;
        var newTotal = (referrerResult.data.affiliate_total_earned_cents || 0) + commission;
        
        await supabase.from('profiles').update({ 
          affiliate_balance_cents: newBalance,
          affiliate_total_earned_cents: newTotal
        }).eq('id', referrerResult.data.id);
        
        // Record the earning
        await supabase.from('affiliate_earnings').insert({
          affiliate_id: referrerResult.data.id,
          referred_id: s.metadata.user_id,
          purchase_id: purchaseResult.data ? purchaseResult.data.id : null,
          amount_cents: commission,
          purchase_amount_cents: s.amount_total,
          status: referrerResult.data.stripe_connect_id ? 'transferred' : 'credited'
        });
        
        // If affiliate has Stripe Connect, transfer immediately
        if (referrerResult.data.stripe_connect_id) {
          try {
            var transfer = await stripe.transfers.create({
              amount: commission,
              currency: 'usd',
              destination: referrerResult.data.stripe_connect_id,
              description: 'Affiliate commission for referral'
            });
            console.log('[CONNECT] Transferred $' + (commission / 100).toFixed(2) + ' to ' + referrerResult.data.stripe_connect_id);
          } catch (te) {
            console.error('[CONNECT] Transfer failed:', te.message);
          }
        }
        
        // Update referral status to converted
        await supabase.from('referrals')
          .update({ status: 'converted' })
          .eq('referred_id', s.metadata.user_id)
          .eq('status', 'signed_up');
        
        console.log('[AFFILIATE] Commission: $' + (commission / 100).toFixed(2) + ' for referrer of ' + profile.email);
      }
    }
  }
  res.json({ received: true });
});

app.post('/api/call', auth, async function(req, res) {
  if (!req.profile.isDev && req.profile.credits < 1) {
    return res.status(402).json({ error: 'No credits' });
  }
  
  var county = req.body.county || "montgomery"; var targetNumber = getCountyConfig(county).number;
  var pin = req.body.pin;
  var notifyNumber = req.body.notifyNumber;
  var notifyEmail = req.body.notifyEmail;
  var notifyMethod = req.body.notifyMethod || 'email';
  var retryOnUnknown = req.body.retryOnUnknown || false;
  
  var countyConfig = COUNTIES[county] || COUNTIES['montgomery'];
  if (countyConfig.process !== 'color' && !pin) return res.status(400).json({ error: 'PIN required for this county' });
  if (!/^\+\d{10,15}$/.test(targetNumber)) return res.status(400).json({ error: 'Invalid phone format' });
  if (pin && (pin.length !== 6 || !/^\d+$/.test(pin))) return res.status(400).json({ error: 'PIN must be 6 digits' });
  
  try {
    var result = await initiateCall(targetNumber, pin, notifyNumber, notifyEmail, notifyMethod, req.user.id, retryOnUnknown, 0, county);
    if (!req.profile.isDev) {
      await supabase.from('profiles').update({ credits: req.profile.credits - 1 }).eq('id', req.user.id);
    }
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

async function initiateCall(targetNumber, pin, notifyNumber, notifyEmail, notifyMethod, userId, retryOnUnknown, retryCount, county) {
  var callId = 'call_' + Date.now();
  log(callId, 'Starting call to ' + targetNumber + (retryCount > 0 ? ' (retry #' + retryCount + ')' : ''), 'info');
  
  pendingCalls.set(callId, { 
    targetNumber: targetNumber, 
    pin: pin,
    county: county, 
    notifyNumber: notifyNumber,
    notifyEmail: notifyEmail,
    notifyMethod: notifyMethod,
    userId: userId, 
    retryOnUnknown: retryOnUnknown,
    retryCount: retryCount,
    result: null
  });
  
  var call = await twilioClient.calls.create({
    to: targetNumber,
    from: TWILIO_VOICE_NUMBER,
    url: process.env.BASE_URL + '/twiml/answer?callId=' + callId,
    statusCallback: process.env.BASE_URL + '/webhook/status?callId=' + callId,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    record: true,
    recordingStatusCallback: process.env.BASE_URL + '/webhook/recording?callId=' + callId,
    timeout: 60
  });
  
  pendingCalls.get(callId).callSid = call.sid;
  log(callId, 'Call SID: ' + call.sid, 'success');
  
  // Clean up old pending calls after 10 minutes
  setTimeout(function() {
    pendingCalls.delete(callId);
  }, 10 * 60 * 1000);
  
  return { success: true, callId: callId, callSid: call.sid };
}

async function scheduleRetry(config) {
  var retryCount = (config.retryCount || 0) + 1;
  if (retryCount > 2) {
    log('retry', 'Max retries reached for user ' + config.userId.slice(0,8) + '...', 'warning');
    await notify(config.notifyNumber, config.notifyEmail, config.notifyMethod, 
      '⚠️ ProbationCall: Could not determine result after multiple attempts. Please call manually.\n\nPIN: ' + config.pin, 'retry');
    return;
  }
  
  log('retry', 'Scheduling retry #' + retryCount + ' in 5 minutes for user ' + config.userId.slice(0,8) + '...', 'info');
  
  setTimeout(async function() {
    log('retry', 'Executing retry #' + retryCount, 'info');
    try {
      await initiateCall(config.targetNumber, config.pin, config.notifyNumber, config.notifyEmail, config.notifyMethod, config.userId, config.retryOnUnknown, retryCount);
    } catch (e) {
      log('retry', 'Retry failed: ' + e.message, 'error');
    }
  }, 5 * 60 * 1000);
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
    
    if (result === 'UNKNOWN' && config.retryOnUnknown && config.retryCount < 2) {
      log(callId, 'Result unknown, will retry in 5 minutes', 'info');
      await scheduleRetry(config);
      if (config.userId) {
        await supabase.from('call_history').insert({ user_id: config.userId, call_sid: config.callSid, target_number: config.targetNumber, pin_used: config.pin, result: 'RETRY_PENDING' });
      }
      broadcastToClients({ type: 'result', callId: callId, result: 'RETRY_PENDING', speech: speech });
    } else {
      var message;
      var isFtbend = config.county === "ftbend";
      if (result === "MUST_TEST") {
        if (isFtbend) {
          message = "🚨 TEST REQUIRED! 🚨\n\nYour color was called. Report for testing today.\n\n- ProbationCall.com";
        } else {
          message = "🚨 TEST REQUIRED! 🚨\n\nYour PIN was called. You MUST test today.\n\nPIN: " + config.pin + "\n\n- ProbationCall.com";
        }
      } else if (result === "NO_TEST") {
        if (isFtbend) {
          message = "✅ No test today!\n\nYour color was NOT called. Enjoy your day!\n\n- ProbationCall.com";
        } else {
          message = "✅ No test today!\n\nYour PIN was NOT called. Enjoy your day!\n\nPIN: " + config.pin + "\n\n- ProbationCall.com";
        }
      } else {
        message = "⚠️ Could not determine result.\n\nHeard: \"" + speech.slice(0, 100) + "\"\n\nPlease call the hotline to verify.\n\n- ProbationCall.com";
      }
      
      await notify(config.notifyNumber, config.notifyEmail, config.notifyMethod, message, callId);
      
      if (config.userId) {
        await supabase.from('call_history').insert({ user_id: config.userId, call_sid: config.callSid, target_number: config.targetNumber, pin_used: config.pin, result: result });
      }
      
      broadcastToClients({ type: 'result', callId: callId, result: result, speech: speech });
    }
  }
  
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/fallback', async function(req, res) {
  var callId = req.query.callId;
  var config = pendingCalls.get(callId);
  
  if (config && !config.result) {
    config.result = 'UNKNOWN';
    
    if (config.retryOnUnknown && config.retryCount < 2) {
      log(callId, 'Fallback - Result unknown, will retry in 5 minutes', 'info');
      await scheduleRetry(config);
      if (config.userId) {
        await supabase.from('call_history').insert({ user_id: config.userId, call_sid: config.callSid, target_number: config.targetNumber, pin_used: config.pin, result: 'RETRY_PENDING' });
      }
      broadcastToClients({ type: 'result', callId: callId, result: 'RETRY_PENDING', speech: '' });
    } else {
      await notify(config.notifyNumber, config.notifyEmail, config.notifyMethod, '⚠️ Call completed but no result detected.\n\nPlease verify manually.\nPIN: ' + config.pin, callId);
      if (config.userId) {
        await supabase.from('call_history').insert({ user_id: config.userId, call_sid: config.callSid, target_number: config.targetNumber, pin_used: config.pin, result: 'UNKNOWN' });
      }
      broadcastToClients({ type: 'result', callId: callId, result: 'UNKNOWN', speech: '' });
    }
  }
  
  var twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

app.post('/webhook/recording', async function(req, res) {
  var callId = req.query.callId;
  var recordingUrl = req.body.RecordingUrl;
  
  console.log('[RECORDING] CallId:', callId, 'URL:', recordingUrl);
  
  if (recordingUrl && callId) {
    var mp3Url = recordingUrl + '.mp3';
    var config = pendingCalls.get(callId);
    
    if (config) {
      if (config.isFtbendDaily) {
        // Fort Bend - save to daily_county_status (overwrites daily)
        var now = new Date();
        var cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
        var today = cst.getFullYear() + '-' + String(cst.getMonth() + 1).padStart(2, '0') + '-' + String(cst.getDate()).padStart(2, '0');
        var countyKey = 'ftbend_' + (config.officeId || 'missouri');
        await supabase.from('daily_county_status')
          .update({ recording_url: mp3Url })
          .eq('county', countyKey)
          .eq('date', today);
        console.log('[RECORDING] Saved Fort Bend daily recording for', countyKey, today);
      } else if (config.callSid) {
        // Montgomery - save to call_history
        await supabase.from('call_history')
          .update({ recording_url: mp3Url })
          .eq('call_sid', config.callSid);
        console.log('[RECORDING] Saved Montgomery recording for', config.callSid);
      }
    }
  }
  res.sendStatus(200);
});

// Cron job to delete old recordings (runs daily at 3am)
cron.schedule('0 3 * * *', async function() {
  console.log('[CLEANUP] Deleting recordings older than 30 days...');
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  
  // Get old recordings
  var old = await supabase.from('call_history')
    .select('recording_url')
    .lt('created_at', cutoff.toISOString())
    .not('recording_url', 'is', null);
  
  if (old.data) {
    for (var i = 0; i < old.data.length; i++) {
      var url = old.data[i].recording_url;
      if (url) {
        // Extract recording SID and delete from Twilio
        var match = url.match(/RE[a-f0-9]{32}/);
        if (match) {
          try {
            await twilioClient.recordings(match[0]).remove();
            console.log('[CLEANUP] Deleted recording', match[0]);
          } catch (e) {
            console.log('[CLEANUP] Could not delete', match[0], e.message);
          }
        }
      }
    }
    // Clear URLs from database
    await supabase.from('call_history')
      .update({ recording_url: null })
      .lt('created_at', cutoff.toISOString());
  }
  console.log('[CLEANUP] Done');
}, { timezone: 'America/Chicago' });

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

async function notify(phone, email, method, message, callId) {
  log(callId, 'Notifying via ' + method, 'info');
  
  if (method === 'email' && email) {
    return await sendEmail(email, message, callId);
  }
  if (method === 'sms' && phone) {
    return await sendSMS(phone, message, callId);
  }
  if (method === 'both') {
    var results = [];
    if (email) results.push(await sendEmail(email, message, callId));
    if (phone) results.push(await sendSMS(phone, message, callId));
    return { success: results.some(function(r) { return r.success; }) };
  }
  if (method === 'whatsapp' && phone) {
    return await sendWhatsApp(phone, message, callId);
  }
  
  log(callId, 'No valid notification method', 'error');
  return { success: false, error: 'No notification method' };
}


async function sendEmail(to, message, callId) {
  if (!process.env.BREVO_KEY) {
    log(callId, "SendGrid not configured", "error");
    return { success: false, error: "Email not configured" };
  }
  
  var subject = "ProbationCall Alert";
  var headerColor = "#00d9ff";
  var resultBadge = "";
  var headerEmoji = "📞";
  
  if (message.includes("MUST TEST") || message.includes("TEST REQUIRED")) {
    subject = "🚨 TEST REQUIRED TODAY - ProbationCall";
    headerColor = "#ef4444";
    resultBadge = "<div style='background:#ef4444;color:#fff;padding:15px 25px;border-radius:8px;font-size:20px;font-weight:bold;text-align:center;margin:20px 0'>⚠️ YOU MUST TEST TODAY</div>";
    headerEmoji = "🚨";
  } else if (message.includes("NO_TEST") || message.includes("No test today") || message.includes("do NOT need to test")) {
    subject = "✅ No Test Today - ProbationCall";
    headerColor = "#22c55e";
    resultBadge = "<div style='background:#22c55e;color:#fff;padding:15px 25px;border-radius:8px;font-size:20px;font-weight:bold;text-align:center;margin:20px 0'>✅ NO TEST REQUIRED</div>";
    headerEmoji = "✅";
  } else if (message.includes("Fort Bend") || message.includes("Color")) {
    subject = "🎨 Fort Bend Color Update - ProbationCall";
    headerColor = "#f59e0b";
    headerEmoji = "🎨";
  }
  
  var html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"></head>" +
    "<body style=\"margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;\">" +
    "<div style=\"max-width:500px;margin:0 auto;padding:20px;\">" +
    "<div style=\"background:linear-gradient(135deg,#0a0a1a,#1a1a2e);border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.15);\">" +
    "<div style=\"background:" + headerColor + ";padding:25px;text-align:center;\">" +
    "<div style=\"font-size:40px;margin-bottom:10px;\">" + headerEmoji + "</div>" +
    "<h1 style=\"margin:0;color:#fff;font-size:24px;font-weight:700;\">ProbationCall</h1></div>" +
    "<div style=\"padding:30px;background:#0a0a1a;\">" + resultBadge +
    "<div style=\"background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:20px;margin:15px 0;\">" +
    "<p style=\"margin:0;color:#e4e4e7;font-size:16px;line-height:1.6;white-space:pre-line;\">" + message + "</p></div>" +
    "<p style=\"margin:20px 0 0;color:#71717a;font-size:13px;text-align:center;\">This is an automated message from ProbationCall</p></div>" +
    "<div style=\"background:rgba(255,255,255,0.03);padding:15px;text-align:center;border-top:1px solid rgba(255,255,255,0.05);\">" +
    "<a href=\"https://probationcall.com\" style=\"color:#00d9ff;text-decoration:none;font-size:14px;\">probationcall.com</a></div>" +
    "</div></div></body></html>";
  try {
    await sgMail.send({
      to: to,
      from: { email: FROM_EMAIL, name: "ProbationCall" },
      subject: subject,
      text: message,
      html: html
    });
    log(callId, "Email sent to " + to, "success");
    return { success: true };
  } catch (e) {
    log(callId, "Email failed: " + e.message, "error");
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
    var msg = await twilioClient.messages.create({ 
      from: WHATSAPP_NUMBER, 
      to: toWA, 
      body: message 
    });
    log(callId, 'WhatsApp sent: ' + msg.sid, 'success');
    return { success: true, sid: msg.sid };
  } catch (e) {
    log(callId, 'WhatsApp failed: ' + e.message, 'error');
    return { success: false, error: e.message };
  }
}

app.post('/api/test-email', auth, async function(req, res) {
  var result = await sendEmail(req.body.email, '✅ Test email from ProbationCall!\n\nIf you see this, email notifications are working.', 'test');
  res.json(result);
});

app.post('/api/test-sms', auth, async function(req, res) {
  var result = await sendSMS(req.body.notifyNumber, 'Test SMS from ProbationCall!', 'test');
  res.json(result);
});

app.post('/api/test-whatsapp', auth, async function(req, res) {
  var result = await sendWhatsApp(req.body.notifyNumber, '✅ Test WhatsApp from ProbationCall!\n\nIf you see this, WhatsApp notifications are working.', 'test');
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
  console.log('Email: ' + (process.env.BREVO_KEY ? 'SendGrid configured' : 'Not configured'));
  console.log('SMS: Messaging Service ' + MESSAGING_SERVICE_SID);
  console.log('WhatsApp: ' + WHATSAPP_NUMBER);
  console.log('Call Hours: ' + MIN_HOUR + ':00 AM - ' + MAX_HOUR + ':59 PM');
  console.log('Stagger Window: ' + STAGGER_MINUTES + ' minutes');
  console.log('Affiliate Commission: ' + AFFILIATE_COMMISSION_PERCENT + '%');
  console.log('Min Payout: $' + (MIN_PAYOUT_CENTS / 100));
  console.log('========================================');
  loadAllSchedules();
});
// ========== ADMIN ROUTES ==========

async function adminAuth(req, res, next) {
  var authHeader = req.headers.authorization;
  var tkn = authHeader ? authHeader.replace('Bearer ', '') : null;
  if (!tkn) return res.status(401).json({ error: 'No token' });
  try {
    var result = await supabase.auth.getUser(tkn);
    if (result.error || !result.data.user) return res.status(401).json({ error: 'Invalid' });
    var pr = await supabase.from('profiles').select('*').eq('id', result.data.user.id).single();
    if (!pr.data || !pr.data.is_admin) return res.status(403).json({ error: 'Not admin' });
    req.user = result.data.user;
    req.profile = pr.data;
    // Track last login
    supabase.from("profiles").update({ last_login: new Date().toISOString() }).eq("id", result.data.user.id);
    next();
  } catch(e) {
    res.status(500).json({ error: 'Auth error' });
  }
}

app.get('/api/admin/check', auth, async function(req, res) {
  res.json({ isAdmin: req.profile.is_admin === true });
});

app.get('/api/admin/dashboard', adminAuth, async function(req, res) {
  try {
    var usersResult = await supabase.from('profiles').select('*').order('created_at', { ascending: false });
    var users = usersResult.data || [];
    
    // Get auth users data for created_at and last_sign_in_at
    var authUsersResult = await supabase.auth.admin.listUsers();
    var authUsers = authUsersResult.data ? authUsersResult.data.users : [];
    
    // Merge auth data into profiles
    users = users.map(function(u) {
      var authUser = authUsers.find(function(a) { return a.id === u.id; });
      if (authUser) {
        u.auth_created_at = authUser.created_at;
        u.last_sign_in_at = authUser.last_sign_in_at;
      }
      return u;
    });
    
    var schedulesResult = await supabase.from('user_schedules').select('*');
    var schedules = schedulesResult.data || [];
    
    var callsResult = await supabase.from('call_history').select('*, profiles(email)').order('created_at', { ascending: false }).limit(500);
    var calls = (callsResult.data || []).map(function(c) {
      return Object.assign({}, c, { user_email: c.profiles ? c.profiles.email : null });
    });
    
    var purchasesResult = await supabase.from('purchases').select('*, profiles(email)').order('created_at', { ascending: false }).limit(500);
    var purchases = (purchasesResult.data || []).map(function(p) {
      return Object.assign({}, p, { user_email: p.profiles ? p.profiles.email : null });
    });
    
    var payoutsResult = await supabase.from('payout_requests').select('*, profiles(email)').order('created_at', { ascending: false });
    var payouts = (payoutsResult.data || []).map(function(p) {
      return Object.assign({}, p, { user_email: p.profiles ? p.profiles.email : null });
    });
    
    var promosResult = await supabase.from('promo_codes').select('*').order('created_at', { ascending: false });
    var promos = promosResult.data || [];
    
    var totalRevenue = 0;
    for (var i = 0; i < purchases.length; i++) {
      totalRevenue += purchases[i].amount_cents || 0;
    }
    
    var pendingPayouts = 0;
    for (var i = 0; i < payouts.length; i++) {
      if (payouts[i].status === 'pending') pendingPayouts++;
    }
    
    var affiliateOwed = 0;
    for (var i = 0; i < users.length; i++) {
      affiliateOwed += users[i].affiliate_balance_cents || 0;
    }
    
    var termsAgreed = 0;
    for (var i = 0; i < users.length; i++) {
      if (users[i].terms_accepted_at) termsAgreed++;
    }
    
    var disabledUsers = 0;
    for (var i = 0; i < users.length; i++) {
      if (users[i].is_disabled) disabledUsers++;
    }
    
    var activeSchedules = 0;
    for (var i = 0; i < schedules.length; i++) {
      if (schedules[i].enabled) activeSchedules++;
    }
    
    res.json({
      stats: {
        totalUsers: users.length,
        activeSchedules: activeSchedules,
        totalCalls: calls.length,
        totalRevenue: totalRevenue,
        pendingPayouts: pendingPayouts,
        affiliateOwed: affiliateOwed,
        termsAgreed: termsAgreed,
        disabledUsers: disabledUsers
      },
      users: users,
      schedules: schedules,
      calls: calls,
      purchases: purchases,
      payouts: payouts,
      promos: promos
    });
  } catch(e) {
    console.error('Admin error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/user/:id/credits', adminAuth, async function(req, res) {
  try {
    var userId = req.params.id;
    var action = req.body.action;
    var amount = parseInt(req.body.amount) || 0;
    var ur = await supabase.from('profiles').select('credits').eq('id', userId).single();
    var curr = ur.data ? ur.data.credits : 0;
    var newC;
    if (action === 'add') {
      newC = curr + amount;
    } else if (action === 'remove') {
      newC = Math.max(0, curr - amount);
    } else if (action === 'set') {
      newC = amount;
    } else {
      newC = curr;
    }
    await supabase.from('profiles').update({ credits: newC }).eq('id', userId);
    console.log('[ADMIN] Credits updated: ' + userId.slice(0,8) + ' ' + curr + ' -> ' + newC);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/user/:id/admin', adminAuth, async function(req, res) {
  try {
    await supabase.from('profiles').update({ is_admin: req.body.isAdmin }).eq('id', req.params.id);
    console.log('[ADMIN] Admin status changed: ' + req.params.id.slice(0,8));
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/user/:id/disable', adminAuth, async function(req, res) {
  try {
    await supabase.from('profiles').update({ is_disabled: req.body.disabled }).eq('id', req.params.id);
    console.log('[ADMIN] Disabled status changed: ' + req.params.id.slice(0,8));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/trigger-ftbend', adminAuth, async function(req, res) {
  console.log('[FTBEND] Manual trigger by admin');
  ftbendDailyColorCall();
  res.json({ success: true, message: 'Fort Bend call triggered' });
});

// Manually trigger a call for a specific user
app.post('/api/admin/trigger-call/:userId', adminAuth, async function(req, res) {
  var userId = req.params.userId;
  
  var schedResult = await supabase.from('user_schedules')
    .select('*')
    .eq('user_id', userId)
    .single();
  
  if (!schedResult.data) {
    return res.status(400).json({ error: 'User has no schedule' });
  }
  
  var sched = schedResult.data;
  console.log('[ADMIN] Triggering call for user ' + userId.slice(0,8) + ' county: ' + sched.county);
  
  if (sched.county === 'ftbend') {
    var now = new Date();
    var cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    var today = cst.getFullYear() + '-' + String(cst.getMonth() + 1).padStart(2, '0') + '-' + String(cst.getDate()).padStart(2, '0');
    
    var colorResult = await supabase.from('daily_county_status')
      .select('color')
      .eq('county', 'ftbend')
      .eq('date', today)
      .single();
    
    var color = colorResult.data ? colorResult.data.color : 'UNKNOWN';
    var message = color === 'UNKNOWN'
      ? '⚠️ ProbationCall: Could not detect today\'s color. Please call +1 (281) 238-3669'
      : '🎨 Fort Bend Color: ' + color.toUpperCase() + '\n\nCheck if this is your assigned color.';
    
    await notify(sched.notify_number, sched.notify_email, sched.notify_method, message, 'admin_trigger');
    console.log('[ADMIN] Sent Fort Bend notification to ' + userId.slice(0,8));
    res.json({ success: true, message: 'Fort Bend notification sent with color: ' + color });
  } else {
    try {
      await initiateCall(
        sched.target_number,
        sched.pin,
        sched.notify_number,
        sched.notify_email,
        sched.notify_method,
        userId,
        sched.retry_on_unknown,
        0,
        sched.county
      );
      console.log('[ADMIN] Initiated Montgomery call for ' + userId.slice(0,8));
      res.json({ success: true, message: 'Call initiated for Montgomery County' });
    } catch (e) {
      console.error('[ADMIN] Call failed:', e);
      res.status(500).json({ error: e.message });
    }
  }
});

app.post('/api/admin/toggle-ftbend', adminAuth, async function(req, res) {
  var userId = req.body.userId;
  var enable = req.body.enable;
  
  var result = await supabase.from('profiles')
    .update({ ftbend_access: enable })
    .eq('id', userId);
  
  if (result.error) {
    console.error('[ADMIN] Toggle ftbend error:', result.error);
    return res.status(500).json({ error: result.error.message });
  }
  res.json({ success: true, ftbend_access: enable });
});

// Set custom referral code for affiliates
app.post('/api/admin/set-referral-code', adminAuth, async function(req, res) {
  var userId = req.body.userId;
  var code = req.body.code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  
  if (code.length < 3 || code.length > 15) {
    return res.status(400).json({ error: 'Code must be 3-15 characters' });
  }
  
  // Check if code already exists
  var existing = await supabase.from('profiles')
    .select('id')
    .eq('referral_code', code)
    .neq('id', userId)
    .single();
  
  if (existing.data) {
    return res.status(400).json({ error: 'Code already in use' });
  }
  
  var result = await supabase.from('profiles')
    .update({ referral_code: code })
    .eq('id', userId);
  
  if (result.error) {
    return res.status(500).json({ error: result.error.message });
  }
  
  console.log('[ADMIN] Set referral code for ' + userId.slice(0,8) + ': ' + code);
  res.json({ success: true, code: code });
});

// Unlock user from affiliate
app.post('/api/admin/unlock-user', adminAuth, async function(req, res) {
  var userId = req.body.userId;
  
  var result = await supabase.from('profiles')
    .update({ referred_by: null })
    .eq('id', userId);
  
  if (result.error) {
    return res.status(500).json({ error: result.error.message });
  }
  
  console.log('[ADMIN] Unlocked user ' + userId.slice(0,8) + ' from affiliate');
  res.json({ success: true });
});

// Delete user schedule
app.delete('/api/admin/schedule/:userId', adminAuth, async function(req, res) {
  var userId = req.params.userId;
  
  var result = await supabase.from('user_schedules')
    .delete()
    .eq('user_id', userId);
  
  if (result.error) {
    return res.status(500).json({ error: result.error.message });
  }
  
  console.log('[ADMIN] Deleted schedule for user ' + userId.slice(0,8));
  res.json({ success: true });
});

app.post('/api/admin/payout/:id', adminAuth, async function(req, res) {
  try {
    await supabase.from('payout_requests').update({
      status: req.body.status,
      processed_at: new Date().toISOString()
    }).eq('id', req.params.id);
    console.log('[ADMIN] Payout processed: ' + req.params.id.slice(0,8) + ' -> ' + req.body.status);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/promo', adminAuth, async function(req, res) {
  try {
    await supabase.from('promo_codes').insert({
      code: req.body.code.toUpperCase(),
      credits: req.body.credits,
      max_uses: req.body.maxUses,
      times_used: 0
    });
    console.log('[ADMIN] Promo created: ' + req.body.code);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/promo/:id', adminAuth, async function(req, res) {
  try {
    await supabase.from('promo_codes').delete().eq('id', req.params.id);
    console.log('[ADMIN] Promo deleted: ' + req.params.id.slice(0,8));
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


app.delete('/api/admin/user/:id', adminAuth, async function(req, res) {
  try {
    var userId = req.params.id;
    console.log('[ADMIN] Deleting user: ' + userId);
    
    // Delete from all related tables
    await supabase.from('user_schedules').delete().eq('user_id', userId);
    console.log('[ADMIN] Deleted user_schedules');
    
    await supabase.from('call_history').delete().eq('user_id', userId);
    console.log('[ADMIN] Deleted call_history');
    
    await supabase.from('purchases').delete().eq('user_id', userId);
    console.log('[ADMIN] Deleted purchases');
    
    await supabase.from('payout_requests').delete().eq('user_id', userId);
    console.log('[ADMIN] Deleted payout_requests');
    
    await supabase.from('referrals').delete().eq('referrer_id', userId);
    await supabase.from('referrals').delete().eq('referred_id', userId);
    console.log('[ADMIN] Deleted referrals');
    
    await supabase.from('affiliate_earnings').delete().eq('affiliate_id', userId);
    await supabase.from('affiliate_earnings').delete().eq('referred_id', userId);
    console.log('[ADMIN] Deleted affiliate_earnings');
    
    await supabase.from('promo_redemptions').delete().eq('user_id', userId);
    console.log('[ADMIN] Deleted promo_redemptions');
    
    // Delete from profiles
    await supabase.from('profiles').delete().eq('id', userId);
    console.log('[ADMIN] Deleted profiles');
    
    // Delete from Supabase auth
    var authResult = await supabase.auth.admin.deleteUser(userId);
    if (authResult.error) {
      console.error('[ADMIN] Auth delete error:', authResult.error);
    } else {
      console.log('[ADMIN] Deleted from auth');
    }
    
    // Remove from scheduled jobs if exists
    if (scheduledJobs.has(userId)) {
      scheduledJobs.get(userId).stop();
      scheduledJobs.delete(userId);
      console.log('[ADMIN] Stopped scheduled job');
    }
    
    console.log('[ADMIN] Successfully deleted user: ' + userId.slice(0,8));
    res.json({ success: true });
  } catch(e) {
    console.error('[ADMIN] Delete user error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ========== END ADMIN ROUTES ==========



// ========== FT BEND DAILY COLOR SYSTEM ==========

// ========== FT BEND MULTI-OFFICE DAILY COLOR SYSTEM ==========

// Call all 3 Fort Bend offices
async function ftbendDailyColorCall() {
  console.log('[FTBEND] Starting daily color detection for ALL offices...');
  
  var offices = Object.keys(FTBEND_OFFICES);
  for (var i = 0; i < offices.length; i++) {
    var officeId = offices[i];
    var office = FTBEND_OFFICES[officeId];
    
    // Stagger calls by 30 seconds each
    (function(oid, off) {
      setTimeout(function() {
        ftbendCallOffice(oid, off);
      }, i * 30000);
    })(officeId, office);
  }
}

// Call a single Fort Bend office
async function ftbendCallOffice(officeId, office) {
  var callId = 'ftbend_' + officeId + '_' + Date.now();
  console.log('[FTBEND] Calling ' + office.name + ' (' + office.number + ')...');
  
  pendingCalls.set(callId, {
    isFtbendDaily: true,
    officeId: officeId,
    officeName: office.name,
    targetNumber: office.number,
    hasPhases: office.hasPhases || false,
    result: null,
    phase1: null,
    phase2: null
  });
  
  try {
    var call = await twilioClient.calls.create({
      to: office.number,
      from: TWILIO_VOICE_NUMBER,
      url: process.env.BASE_URL + '/twiml/ftbend-answer?callId=' + callId + '&officeId=' + officeId,
      statusCallback: process.env.BASE_URL + '/webhook/status?callId=' + callId,
      record: true,
      recordingStatusCallback: process.env.BASE_URL + '/webhook/recording?callId=' + callId,
      timeout: 60
    });
    
    pendingCalls.get(callId).callSid = call.sid;
    console.log('[FTBEND] ' + office.name + ' call initiated: ' + call.sid);
  } catch (e) {
    console.error('[FTBEND] ' + office.name + ' call failed:', e.message);
  }
}

app.post('/twiml/ftbend-answer', function(req, res) {
  var callId = req.query.callId;
  var officeId = req.query.officeId;
  var config = pendingCalls.get(callId);
  var twiml = new twilio.twiml.VoiceResponse();
  
  console.log('[FTBEND] Call answered for office: ' + officeId);
  twiml.pause({ length: 3 });
  twiml.gather({
    input: 'speech',
    timeout: 45,
    speechTimeout: 10,
    action: process.env.BASE_URL + '/twiml/ftbend-result?callId=' + callId + '&officeId=' + officeId,
    hints: FTBEND_COLORS.join(', ') + ', color, today, is, phase, one, two, 1, 2',
    language: 'en-US',
    profanityFilter: false
  });
  twiml.redirect(process.env.BASE_URL + '/twiml/ftbend-fallback?callId=' + callId + '&officeId=' + officeId);
  
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/ftbend-result', async function(req, res) {
  var callId = req.query.callId;
  var officeId = req.query.officeId;
  var speech = req.body.SpeechResult || '';
  var config = pendingCalls.get(callId);
  var twiml = new twilio.twiml.VoiceResponse();
  
  console.log('[FTBEND] ' + officeId + ' speech: "' + speech + '"');
  
  if (config && !config.result) {
    // Check for phase 1 / phase 2 in the speech (for rosenberg2)
    if (config.hasPhases) {
      var phases = detectPhaseColors(speech);
      config.phase1 = phases.phase1;
      config.phase2 = phases.phase2;
      config.result = phases.phase1 || phases.phase2 ? 'PHASES' : 'UNKNOWN';
      await storeFtbendColor(config.result, speech, officeId, phases.phase1, phases.phase2);
    } else {
      var detectedColor = detectColor(speech);
      if (detectedColor) {
        console.log('[FTBEND] ' + officeId + ' color: ' + detectedColor);
        config.result = detectedColor;
        await storeFtbendColor(detectedColor, speech, officeId, null, null);
      } else {
        config.result = 'UNKNOWN';
        await storeFtbendColor('UNKNOWN', speech, officeId, null, null);
      }
    }
    
    // Notify users subscribed to this office (don't await - let webhook return fast)
    notifyFtbendOfficeUsers(officeId, config).catch(function(e) {
      console.error('[FTBEND] Notification error:', e.message);
    });
  }
  
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/ftbend-fallback', async function(req, res) {
  var callId = req.query.callId;
  var officeId = req.query.officeId;
  var config = pendingCalls.get(callId);
  
  console.log('[FTBEND] ' + officeId + ' fallback - no speech detected');
  
  if (config && !config.result) {
    config.result = 'UNKNOWN';
    await storeFtbendColor('UNKNOWN', '', officeId, null, null);
    notifyFtbendOfficeUsers(officeId, config).catch(function(e) {
      console.error('[FTBEND] Fallback notification error:', e.message);
    });
  }
  
  var twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// Detect phase 1 and phase 2 colors from speech
function detectPhaseColors(transcript) {
  var lower = transcript.toLowerCase();
  console.log("[FTBEND] Analyzing phases in: " + lower);
  
  // Extract whatever comes after "today is" until "remember" or end
  var todayIsMatch = lower.match(/today\s+is[,:]?\s*(.+?)(?:remember|you\s+will|\.|$)/i);
  if (!todayIsMatch || !todayIsMatch[1]) {
    console.log("[FTBEND] Could not find today is pattern");
    return { phase1: null, phase2: null };
  }
  
  var announcement = todayIsMatch[1].trim();
  console.log("[FTBEND] Raw announcement: " + announcement);
  
  // Split by "and" or commas
  var parts = announcement.split(/\s+and\s+|,\s*/).map(function(p) {
    return p.trim();
  }).filter(function(p) {
    return p.length > 0;
  });
  
  // Clean up each part - capitalize first letter of each word
  var cleaned = parts.map(function(p) {
    return p.split(" ").map(function(word) {
      return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(" ");
  });
  
  console.log("[FTBEND] Detected groups: " + cleaned.join(", "));
  
  var phase1 = cleaned.length > 0 ? cleaned[0] : null;
  var phase2 = cleaned.length > 1 ? cleaned.slice(1).join(", ") : null;
  
  return { phase1: phase1, phase2: phase2 };
}



async function storeFtbendColor(color, transcript, officeId, phase1, phase2) {
  var now = new Date();
  var cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  var today = cst.getFullYear() + '-' + String(cst.getMonth() + 1).padStart(2, '0') + '-' + String(cst.getDate()).padStart(2, '0');
  
  var office = FTBEND_OFFICES[officeId] || { name: officeId };
  console.log('[FTBEND] Storing ' + office.name + ' color: ' + color + ' for ' + today);
  
  try {
    var countyKey = 'ftbend_' + officeId;
    
    var existing = await supabase.from('daily_county_status')
      .select('*')
      .eq('county', countyKey)
      .eq('date', today)
      .single();
    
    var data = {
      county: countyKey,
      date: today,
      color: color,
      transcript: transcript,
      phase1_color: phase1,
      phase2_color: phase2,
      office_name: office.name
      
    };
    
    var result;
    if (existing.data) {
      result = await supabase.from('daily_county_status')
        .update(data)
        .eq('id', existing.data.id);
    } else {
      result = await supabase.from('daily_county_status').insert(data);
    }
    
    if (result.error) {
      console.error('[FTBEND] Database error:', result.error);
    } else {
      console.log('[FTBEND] Stored ' + office.name + ' color: ' + color);
    }
  } catch (e) {
    console.error('[FTBEND] Exception storing color:', e.message);
  }
}

async function notifyFtbendOfficeUsers(officeId, config) {
  var office = FTBEND_OFFICES[officeId] || { name: officeId };
  
  // Get users subscribed to this specific office
  var result = await supabase.from('user_schedules')
    .select('*')
    .eq('county', 'ftbend')
    .eq('ftbend_office', officeId)
    .eq('enabled', true);
  
  if (!result.data || result.data.length === 0) {
    console.log('[FTBEND] No users subscribed to ' + office.name);
    return;
  }
  
  console.log('[FTBEND] Notifying ' + result.data.length + ' users for ' + office.name);
  
  var message;
  if (config.phase1 || config.phase2) {
    message = '🎨 Fort Bend ' + office.name + ' Colors:\n';
    if (config.phase1) message += '• Color 1: ' + config.phase1.toUpperCase() + '\n';
    if (config.phase2) message += '• Color 2: ' + config.phase2.toUpperCase() + '\n';
    message += '\nCheck if this is your assigned color.';
  } else if (config.result && config.result !== 'UNKNOWN' && config.result !== 'PHASES') {
    message = '🎨 Fort Bend ' + office.name + ': ' + config.result.toUpperCase() + '\n\nCheck if this is your assigned color.';
  } else {
    message = '⚠️ ProbationCall: Could not detect ' + office.name + ' color. Please call ' + (FTBEND_OFFICES[officeId] ? FTBEND_OFFICES[officeId].number : '+12812383668');
  }
  
  var now = new Date();
  var cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  var currentHour = cst.getHours();
  var currentMin = cst.getMinutes();
  
  for (var i = 0; i < result.data.length; i++) {
    var sched = result.data[i];
    var schedHour = sched.hour !== undefined ? sched.hour : 5;
    var schedMin = sched.minute !== undefined ? sched.minute : 10;
    
    var delayMs = i * 2000;
    if (schedHour > currentHour || (schedHour === currentHour && schedMin > currentMin)) {
      var minutesUntil = (schedHour - currentHour) * 60 + (schedMin - currentMin);
      delayMs = minutesUntil * 60 * 1000 + (i * 1000);
    }
    
    (function(s, delay, msg, oid, cfg) {
      setTimeout(async function() {
        var profileResult = await supabase.from('profiles').select('credits, email').eq('id', s.user_id).single();
        var profile = profileResult.data;
        if (!profile) return;
        var isDevUser = isDev(profile.email);
        if (!isDevUser && profile.credits < 1) {
          var skipCount = (s.no_credit_skip_count || 0) + 1;
          console.log('[FTBEND] User ' + s.user_id.slice(0,8) + '... has no credits, skipping');
          if (skipCount >= 2) {
            await supabase.from('user_schedules').delete().eq('user_id', s.user_id);
            await notify(s.notify_number, s.notify_email, s.notify_method, 'ProbationCall: Your schedule has been removed due to no credits. Please log in, purchase credits, and set up your schedule again at probationcall.com', 'ftbend');
          } else {
            await supabase.from('user_schedules').update({ no_credit_skip_count: skipCount }).eq('user_id', s.user_id);
            await notify(s.notify_number, s.notify_email, s.notify_method, 'ProbationCall: Your scheduled call was skipped due to insufficient credits. Please log in and purchase credits at probationcall.com to continue service. Your schedule will be removed tomorrow if credits are not added.', 'ftbend');
          }
          await supabase.from('call_history').insert({ user_id: s.user_id, target_number: FTBEND_OFFICES[oid] ? FTBEND_OFFICES[oid].number : COUNTIES.ftbend.number, result: 'NO_CREDITS', county: 'ftbend', ftbend_office: oid });
          return;
        }
        console.log('[FTBEND] Sending ' + oid + ' notification to ' + s.user_id.slice(0,8));
        await notify(s.notify_number, s.notify_email, s.notify_method, msg, 'ftbend_daily');
        if (!isDevUser) {
          await supabase.from('profiles').update({ credits: profile.credits - 1 }).eq('id', s.user_id);
          console.log('[FTBEND] Deducted 1 credit from ' + s.user_id.slice(0,8));
        }
        await supabase.from('call_history').insert({
          user_id: s.user_id,
          target_number: FTBEND_OFFICES[oid] ? FTBEND_OFFICES[oid].number : COUNTIES.ftbend.number,
          result: cfg.hasPhases ? 'P1:' + (cfg.phase1 || '?') + ' P2:' + (cfg.phase2 || '?') : 'COLOR:' + cfg.result,
          county: 'ftbend',
          ftbend_office: oid
        });
      }, delay);
    })(sched, delayMs, message, officeId, config);
  }
}

// Cron job - 5:05 AM CST every day, calls all offices
cron.schedule('5 5 * * *', function() {
  console.log('[FTBEND] Cron triggered - starting daily color calls for all offices');
  ftbendDailyColorCall();
}, { timezone: 'America/Chicago' });

app.get("/api/ftbend/colors", auth, async function(req, res) {
  // Get colors from all Fort Bend offices
  var result = await supabase.from("daily_county_status")
    .select("*")
    .like("county", "ftbend%")
    .order("date", { ascending: false })
    .limit(270);
  
  res.json({ colors: result.data || [], offices: FTBEND_OFFICES });
});

app.get('/api/recording/:recordingSid', function(req, res) {
  var recordingSid = req.params.recordingSid;
  var https = require('https');
  
  var options = {
    hostname: 'api.twilio.com',
    path: '/2010-04-01/Accounts/' + process.env.TWILIO_ACCOUNT_SID + '/Recordings/' + recordingSid + '.mp3',
    auth: process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN
  };
  
  https.get(options, function(twilioRes) {
    if (twilioRes.statusCode !== 200) {
      return res.status(404).json({ error: 'Recording not found' });
    }
    res.set('Content-Type', 'audio/mpeg');
    twilioRes.pipe(res);
  }).on('error', function(e) {
    console.error('[RECORDING] Proxy error:', e.message);
    res.status(500).json({ error: e.message });
  });
});

app.get("/api/ftbend/today", async function(req, res) {
  var now = new Date();
  var cst = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  var hour = cst.getHours();
  
  var dateToShow = new Date(cst);
  if (hour < 4) {
    dateToShow.setDate(dateToShow.getDate() - 1);
  }
  var dateStr = dateToShow.toISOString().split("T")[0];
  
  // Get all office colors for today
  var result = await supabase.from("daily_county_status")
    .select("*")
    .like("county", "ftbend%")
    .eq("date", dateStr);
  
  var offices = {};
  if (result.data) {
    result.data.forEach(function(r) {
      var officeId = r.county.replace("ftbend_", "");
      offices[officeId] = {
        color: r.color,
        phase1: r.phase1_color,
        phase2: r.phase2_color,
        office_name: r.office_name,
        recording_url: r.recording_url,
        transcript: r.transcript
      };
    });
  }
  
  res.json({ date: dateStr, offices: offices, officeConfig: FTBEND_OFFICES });
});


// ========== END FT BEND SYSTEM ==========


// Save probation end date
app.post('/api/profile/probation-end', auth, async function(req, res) {
  var endDate = req.body.endDate;
  if (!endDate) return res.status(400).json({ error: 'End date required' });
  
  await supabase.from('profiles').update({ 
    probation_end_date: endDate 
  }).eq('id', req.user.id);
  
  res.json({ success: true });
});

// Save user's assigned color (for Ft Bend)
app.post('/api/profile/color', auth, async function(req, res) {
  var color = req.body.color;
  if (!color) return res.status(400).json({ error: 'Color required' });
  
  await supabase.from('profiles').update({ 
    user_color: color.toLowerCase() 
  }).eq('id', req.user.id);
  
  res.json({ success: true });
});

// Calculate credits needed for remaining probation
app.get('/api/calculate-credits', auth, async function(req, res) {
  var endDate = req.query.endDate;
  if (!endDate) return res.status(400).json({ error: 'End date required' });
  
  var end = new Date(endDate);
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  
  var daysRemaining = Math.ceil((end - today) / (1000 * 60 * 60 * 24));
  if (daysRemaining < 0) daysRemaining = 0;
  
  // Pricing: roughly $0.33 per credit at bulk rate
  var creditsNeeded = daysRemaining;
  var pricePerCredit = 44; // cents (bulk rate ~$0.22/credit)
  var totalCents = creditsNeeded * pricePerCredit;
  
  // Minimum $5
  if (totalCents < 500 && totalCents > 0) totalCents = 500;
  
  res.json({
    daysRemaining: daysRemaining,
    creditsNeeded: creditsNeeded,
    priceCents: totalCents,
    priceDisplay: '$' + (totalCents / 100).toFixed(2)
  });
});

// Custom credits purchase for exact probation length
app.post('/api/checkout/custom', auth, async function(req, res) {
  var credits = parseInt(req.body.credits);
  var priceCents = parseInt(req.body.priceCents);
  
  if (!credits || credits < 1) return res.status(400).json({ error: 'Invalid credits' });
  if (!priceCents || priceCents < 500) return res.status(400).json({ error: 'Minimum $5' });
  
  var session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: 'ProbationCall - ' + credits + ' Credits (Custom)' },
        unit_amount: priceCents
      },
      quantity: 1
    }],
    mode: 'payment',
    success_url: process.env.BASE_URL + '/dashboard?success=true',
    cancel_url: process.env.BASE_URL + '/dashboard?canceled=true',
    metadata: { user_id: req.user.id, package_id: 'custom', credits: String(credits) }
  });
  
  res.json({ url: session.url });
});

// Mark onboarding complete
app.post('/api/profile/onboarding-complete', auth, async function(req, res) {
  await supabase.from('profiles').update({ 
    onboarding_complete: true 
  }).eq('id', req.user.id);
  
  res.json({ success: true });
});


module.exports = app;

// ========== MISSED CALL RECOVERY ==========
// Runs every hour to catch any missed scheduled calls
cron.schedule('45 * * * *', async function() {
  console.log('[RECOVERY] Checking for missed calls...');
  
  var now = new Date();
  var cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  var currentHour = cst.getHours();
  var currentMin = cst.getMinutes();
  var todayStart = new Date(cst);
  todayStart.setHours(0, 0, 0, 0);
  
  // Get all enabled schedules that should have run by now
  var schedResult = await supabase.from('user_schedules')
    .select('*')
    .eq('enabled', true)
    .neq('county', 'ftbend'); // Ft Bend handled separately
  
  if (!schedResult.data || schedResult.data.length === 0) return;
  
  for (var i = 0; i < schedResult.data.length; i++) {
    var sched = schedResult.data[i];
    var schedHour = sched.hour || 6;
    var schedMin = sched.minute || 0;
    
    // Calculate minutes since scheduled time
    var minutesSinceScheduled = (currentHour - schedHour) * 60 + (currentMin - schedMin);
    
    // Skip if scheduled time hasn't passed OR if within 20-min stagger window
    if (minutesSinceScheduled < 20) continue;
    
    // Check if call was made today
    var callResult = await supabase.from('call_history')
      .select('id')
      .eq('user_id', sched.user_id)
      .gte('created_at', todayStart.toISOString())
      .limit(1);
    
    if (callResult.data && callResult.data.length > 0) continue; // Already called today
    
    console.log('[RECOVERY] MISSED CALL detected for user ' + sched.user_id.slice(0,8) + '... (scheduled ' + schedHour + ':' + String(schedMin).padStart(2,'0') + ')');
    
    // Get user profile and credits
    var profileResult = await supabase.from('profiles').select('credits, email').eq('id', sched.user_id).single();
    var profile = profileResult.data;
    if (!profile) continue;
    
    var isDevUser = isDev(profile.email);
    
    if (!isDevUser && profile.credits < 1) {
      console.log('[RECOVERY] User ' + sched.user_id.slice(0,8) + '... has no credits, skipping');
      await notify(sched.notify_number, sched.notify_email, sched.notify_method, '⚠️ ProbationCall: Your scheduled call was missed and you have no credits!', 'recovery'); await supabase.from('call_history').insert({ user_id: sched.user_id, target_number: sched.target_number, pin_used: sched.pin, result: 'NO_CREDITS' });
      await supabase.from('call_history').insert({ user_id: sched.user_id, target_number: sched.target_number, pin_used: sched.pin, result: 'NO_CREDITS' });
      await supabase.from('call_history').insert({ user_id: sched.user_id, target_number: sched.target_number, pin_used: sched.pin, result: 'NO_CREDITS' });
      continue;
    }
    
    // Make the recovery call
    console.log('[RECOVERY] Initiating recovery call for ' + sched.user_id.slice(0,8) + '...');
    try {
      await initiateCall(sched.target_number, sched.pin, sched.notify_number, sched.notify_email, sched.notify_method, sched.user_id, sched.retry_on_unknown, 0);
      
      if (!isDevUser) {
        await supabase.from('profiles').update({ credits: profile.credits - 1 }).eq('id', sched.user_id);
      }
    } catch (e) {
      console.error('[RECOVERY] Call failed for ' + sched.user_id.slice(0,8) + '...:', e.message);
      await notify(sched.notify_number, sched.notify_email, sched.notify_method, '⚠️ ProbationCall: Recovery call failed! Please check manually.', 'recovery');
    }
    
    // Small delay between recovery calls
    await new Promise(function(r) { setTimeout(r, 5000); });
  }
  
  console.log('[RECOVERY] Check complete');
}, { timezone: 'America/Chicago' });
