const fs = require('fs');

const serverPath = 'server.js';
if (fs.existsSync(serverPath)) {
    let code = fs.readFileSync(serverPath, 'utf8');

    // 1. Locate the Transporter configuration
    // We are replacing the simple config with a robust, timeout-enabled config
    const oldConfigRegex = /nodemailer\.createTransport\(\{[\s\S]*?auth: \{[\s\S]*?\}[\s\S]*?\}\);/;
    
    const newConfig = `nodemailer.createTransport({
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
});`;

    if (code.match(oldConfigRegex)) {
        code = code.replace(oldConfigRegex, newConfig);
        fs.writeFileSync(serverPath, code);
        console.log('✅ server.js updated: Added timeouts and security settings to prevent hanging.');
    } else {
        console.log('⚠️ Could not find the transporter config. Please ensure "nodemailer.createTransport" is in server.js');
    }
}
