// ---------- the nag brain ----------
async function nagCheck() {
  const settings = data.settings;
  if (!settings.enabled || !data.subscription) {
    console.log('[nag] skip: disabled or no subscription (enabled=' + settings.enabled + ', hasSub=' + !!data.subscription + ')');
    return;
  }
  const now = new Date();
  const hm = pad(now.getHours()) + ':' + pad(now.getMinutes());
  if (!withinActiveHours(now, settings)) {
    console.log('[nag] skip: outside active hours (now=' + hm + ', window=' + settings.quietStart + '-' + settings.quietEnd + ')');
    return;
  }
  if (withinWindow(now, settings.eveningTime, 15)) {
    console.log('[nag] skip: inside evening-digest window');
    return;
  }

  const pending = pendingTasks();
  if (pending.length === 0) {
    console.log('[nag] skip: no pending tasks due today/overdue');
    return;
  }

  if (data.nag.nextEligibleAt && now < new Date(data.nag.nextEligibleAt)) {
    console.log('[nag] skip: waiting until ' + data.nag.nextEligibleAt + ' (now=' + now.toISOString() + ')');
    return;
  }

  console.log('[nag] conditions met, sending push. pending=' + pending.length);

  let title, body, taskId = null;
  const overdueCount = pending.filter(t => t.dueDate < todayStr()).length;

  const pickSpecific = settings.randomMode && Math.random() < 0.7;
  if (pickSpecific) {
    const task = pending[Math.floor(Math.random() * pending.length)];
    taskId = task.id;
    title = 'Still on your list';
    body = task.title + (task.dueDate < todayStr() ? ' — overdue' : ' — due today');
  } else {
    title = 'Pending tasks';
    body = pending.length + (pending.length === 1 ? ' task is' : ' tasks are') + ' waiting for you today' +
      (overdueCount > 0 ? ` (${overdueCount} overdue)` : '');
  }

  const sent = await sendPush({ title, body, taskId });
  console.log('[nag] push send result: ' + sent);
  if (sent) {
    data.nag.lastSentAt = now.toISOString();
    data.nag.nextEligibleAt = new Date(now.getTime() + settings.intervalMinutes * 60000).toISOString();
    saveData(data);
  }
}

async function eveningCheck() {
  const settings = data.settings;
  if (!settings.enabled || !data.subscription) return;
  const now = new Date();
  const today = todayStr();
  if (data.eveningSummary.lastSentDate === today) return;
  if (!withinWindow(now, settings.eveningTime, 5)) return;

  const leftToday = pendingTasks();
  const tomorrow = tasksDueTomorrow();

  if (leftToday.length === 0 && tomorrow.length === 0) {
    data.eveningSummary.lastSentDate = today;
    saveData(data);
    return;
  }

  const parts = [];
  if (leftToday.length > 0) parts.push(`${leftToday.length} left undone today`);
  if (tomorrow.length > 0) parts.push(`${tomorrow.length} coming up tomorrow`);

  const sent = await sendPush({ title: 'Evening check-in', body: parts.join(' · '), taskId: null });
  if (sent) {
    data.eveningSummary.lastSentDate = today;
    saveData(data);
  }
}

cron.schedule('* * * * *', () => {
  nagCheck().catch(e => console.error(e));
  eveningCheck().catch(e => console.error(e));
});

// ---------- API ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/tasks', (req, res) => res.json(data.tasks));

app.post('/api/tasks', (req, res) => {
  const t = req.body;
  t.id = uid();
  t.done = false;
  t.createdAt = todayStr();
  data.tasks.push(t);
  saveData(data);
  res.json(t);
});

app.put('/api/tasks/:id', (req, res) => {
  const idx = data.tasks.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.tasks[idx] = Object.assign({}, data.tasks[idx], req.body);
  saveData(data);
  res.json(data.tasks[idx]);
});

app.post('/api/tasks/:id/complete', (req, res) => {
  const t = data.tasks.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.recurring) {
    t.dueDate = addInterval(t.dueDate, t.every, t.unit);
    t.lastCompleted = todayStr();
  } else {
    t.done = true;
  }
  // small reward buffer so the app doesn't immediately nag again after you clear one
  const now = new Date();
  data.nag.nextEligibleAt = new Date(now.getTime() + 15 * 60000).toISOString();
  saveData(data);
  res.json(t);
});

app.delete('/api/tasks/:id', (req, res) => {
  data.tasks = data.tasks.filter(x => x.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

app.get('/api/settings', (req, res) => res.json(data.settings));
app.post('/api/settings', (req, res) => {
  data.settings = Object.assign({}, data.settings, req.body);
  saveData(data);
  res.json(data.settings);
});

app.get('/api/vapid-public-key', (req, res) => res.json({ key: VAPID_PUBLIC_KEY }));

app.post('/api/subscribe', (req, res) => {
  data.subscription = req.body;
  saveData(data);
  res.json({ ok: true });
});

app.post('/api/dismiss', (req, res) => {
  // "remind me later" tap - push the next nag out by a fresh full interval
  const now = new Date();
  data.nag.nextEligibleAt = new Date(now.getTime() + data.settings.intervalMinutes * 60000).toISOString();
  saveData(data);
  res.json({ ok: true });
});

app.post('/api/test-notification', async (req, res) => {
  const sent = await sendPush({ title: 'Upkeep', body: 'This is a test nudge — notifications are working.', taskId: null });
  res.json({ sent });
});

app.listen(PORT, () => console.log('Upkeep server listening on port ' + PORT + ' (loading data...)'));

loadData().then(d => {
  data = d;
}).catch(e => console.error('Failed to load data on startup', e));