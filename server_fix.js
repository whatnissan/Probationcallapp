// Find this section in your server.js:
app.get('/api/user', auth, async function(req, res) {
  var historyResult = await supabase.from('call_history').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(30);
  var scheduleResult = await supabase.from('user_schedules').select('*').eq('user_id', req.user.id).single();
  
  // FIX: Handle when no schedule exists
  var schedule = (scheduleResult.error || !scheduleResult.data) ? null : scheduleResult.data;
  
  res.json({ 
    user: req.user, 
    profile: req.profile, 
    history: historyResult.data || [], 
    schedule: schedule,
    isDev: isDev(req.user.email)
  });
});
