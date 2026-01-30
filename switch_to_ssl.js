const fs = require('fs');
const path = './server.js';
let code = fs.readFileSync(path, 'utf8');

// 1. Force Port 465
if (code.includes('port:')) {
    code = code.replace(/port: \d+,/g, 'port: 465,');
}

// 2. Force Secure: true (REQUIRED for 465)
if (code.includes('secure:')) {
    code = code.replace(/secure: (true|false),/g, 'secure: true,');
} else {
    // If setting doesn't exist, add it after port
    code = code.replace('port: 465,', 'port: 465,\n  secure: true,');
}

fs.writeFileSync(path, code);
console.log('✅ Switched to Port 465 (SSL) and Secure: true');
