#!/bin/bash

# Backup
cp server.js server.js.backup

# Fix: Change schedule response to explicitly handle errors
python3 << 'PY'
import re
p = open("server.js").read()

# Find and replace the /api/user endpoint
old = """app.get('/api/user', auth, async function(req, res) {
  var historyResult = await supabase.from('call_history').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(30);
  var scheduleResult = await supabase.from('user_schedules').select('*').eq('user_id', req.user.id).single();
  res.json({ 
    user: req.user, 
    profile: req.profile, 
    history: historyResult.data || [], 
    schedule: scheduleResult.data,
    isDev: isDev(req.user.email)
  });
});"""

new = """app.get('/api/user', auth, async function(req, res) {
  var historyResult = await supabase.from('call_history').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(30);
  var scheduleResult = await supabase.from('user_schedules').select('*').eq('user_id', req.user.id).single();
  
  // Handle schedule: if error (no rows), return null instead of undefined
  var schedule = scheduleResult.error ? null : scheduleResult.data;
  
  res.json({ 
    user: req.user, 
    profile: req.profile, 
    history: historyResult.data || [], 
    schedule: schedule,
    isDev: isDev(req.user.email)
  });
});"""

p = p.replace(old, new)
open("server.js", "w").write(p)
print("✅ Fixed schedule response handling")
PY

echo ""
echo "✅ Schedule fix applied!"
echo ""
echo "Now push to Railway:"
echo "git add server.js && git commit -m 'fix schedule display' && git push railway main"
