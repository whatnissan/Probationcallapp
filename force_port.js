const fs = require('fs');
const path = './server.js';
let code = fs.readFileSync(path, 'utf8');

if (code.includes('port: 587')) {
    code = code.replace('port: 587', 'port: 2525');
    fs.writeFileSync(path, code);
    console.log('✅ SUCCESS: server.js forced to Port 2525.');
} else if (code.includes('port: 2525')) {
    console.log('ℹ️ NOTE: It is ALREADY set to 2525.');
} else {
    console.log('⚠️ WARNING: Could not find the port setting to change.');
}
