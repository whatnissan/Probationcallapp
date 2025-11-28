#!/bin/bash

# Fix 1: Handle missing schedule properly
sed -i '' 's/schedule: scheduleResult.data,/schedule: scheduleResult.data || null,/' server.js

# Fix 2: Add email notification fallback
cat >> server.js << 'EOFSERVER'

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
EOFSERVER

# Fix 3: Update sendNotification to include email fallback
sed -i '' '/async function sendNotification/,/^}/ {
  /console.log.*Notification sent/i\
\  await sendEmailNotification(userEmail, result, pin);
}' server.js

echo "✅ Fixes applied!"
echo ""
echo "Next steps:"
echo "1. Add these to your Railway environment variables:"
echo "   EMAIL_USER=your-gmail@gmail.com"
echo "   EMAIL_PASS=your-app-password"
echo ""
echo "2. Get Gmail App Password:"
echo "   - Go to: https://myaccount.google.com/apppasswords"
echo "   - Generate a new app password"
echo "   - Use that password (not your regular Gmail password)"
echo ""
echo "3. Push to Railway:"
echo "   git add . && git commit -m 'fix schedule display and add email notifications' && git push railway main"

