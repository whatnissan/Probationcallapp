const fs = require('fs');
const path = './server.js';
let code = fs.readFileSync(path, 'utf8');

// The new API-based email function
const newEmailLogic = `
// REPLACED: SMTP Transporter with Direct API Call
const sendEmail = async (to, subject, text) => {
  console.log(\`[API] Sending to \${to}...\`);
  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': process.env.BREVO_KEY, 
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'Probation Alerts', email: 'alerts@probationcall.com' },
        to: [{ email: to }],
        subject: subject,
        htmlContent: \`<html><body><p>\${text}</p></body></html>\`
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('✅ [API] Email Sent:', data.messageId);
    } else {
      const err = await response.text();
      console.error('❌ [API] Error:', err);
    }
  } catch (err) {
    console.error('❌ [API] Network Error:', err.message);
  }
};
`;

// 1. Remove the old nodemailer setup
if (code.includes('nodemailer.createTransport')) {
    code = code.replace(/const transporter = nodemailer.createTransport\(\{[\s\S]*?\}\);/g, '// Old SMTP Transporter removed');
    code = code.replace(/const nodemailer = require\('nodemailer'\);/g, '// const nodemailer = require("nodemailer");');
}

// 2. Replace the send call
const oldSendRegex = /await transporter\.sendMail\(\{[\s\S]*?\}\);/g;
if (code.match(oldSendRegex)) {
   code = code.replace(oldSendRegex, 'await sendEmail(user.email, "Probation Alert", "This is your scheduled probation check-in.");');
}

// 3. Add the new function to the top
code = newEmailLogic + '\n' + code;

fs.writeFileSync(path, code);
console.log('✅ Converted from SMTP to HTTP API.');
