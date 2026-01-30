const fs = require('fs');
const path = './server.js';
let code = fs.readFileSync(path, 'utf8');

// 1. FIX THE SERVER PORT
// The previous script accidentally changed "app.listen(8080)" to "app.listen(465)"
// We must restore "process.env.PORT" so Railway can find the app.

// Regex to find app.listen(...) and force it to use process.env.PORT
const listenRegex = /app\.listen\s*\(\s*(\d+|process\.env\.PORT[^,]*)(.*)/;

if (code.match(listenRegex)) {
    // Replace with standard Railway port logic
    code = code.replace(listenRegex, "app.listen(process.env.PORT || 8080$2");
    console.log('✅ SERVER PORT RESTORED: App now listens on process.env.PORT');
} else {
    // Fallback: If regex misses, append the correct listen at the bottom (commenting out others if needed)
    console.log('⚠️ Could not auto-replace listener. Appending safe listener.');
    code += `\n\n// SAFETY FALLBACK\nconst PORT = process.env.PORT || 8080;\napp.listen(PORT, () => console.log('Server running on port ' + PORT));\n`;
}

// 2. ENSURE HEALTH CHECK EXISTS
// Railway needs a "/" route to say "200 OK".
if (!code.includes("app.get('/',")) {
    code = code.replace("app.listen", "app.get('/', (req, res) => res.send('ProbationCall Active'));\n\napp.listen");
    console.log('✅ Added missing Health Check route "/"');
}

fs.writeFileSync(path, code);
