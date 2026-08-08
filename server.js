const express = require('express');
const path = require('path');
const webpush = require('web-push');
const cron = require('node-cron');

const PORT = process.env.PORT || 3000;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:you@example.com';

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const DATA_KEY = 'upkeep-data';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('VAPID keys are not set. Run `npm run generate-vapid` and set the env vars, or push notifications will fail.');
}
if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.warn('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set. Tasks will only live in memory and will be lost on restart. See README.');
}

// ---------- data layer: in-memory cache, write-through to Upstash Redis ----------
function defaultData() {
  return {
    tasks: [],
    settings: {
      enabled: true,
      intervalMinutes: 90,
      quietStart: '08:00',
      quietEnd: '21:30',
      eveningTime: '20:30',
      randomMode: true
    },
    subscription: null,
    nag: { lastSentAt: null, nextEligibleAt: null },
    eveningSummary: { lastSentDate: null }
  };
}

async function loadData() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.warn('No Upstash configured, using in-memory defaults');
    return defaultData();
  }
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${DATA_KEY}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const json = await res.json();
    if (json.result) {
      const parsed = JSON.parse(json.result);
      console.log('Loaded from Upstash: ' + parsed.tasks.length + ' tasks');
      return parsed;
    }
    console.log('No existing Upstash data found, starting fresh');
    const d = defaultData();
    await persistData(d);
    return d;
  } catch (e) {
    console.error('Upstash load failed, starting from defaults', e);
    return defaultData();
  }
}

async function persistData(d) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.warn('Skipped saving: UPSTASH_REDIS_REST_URL/TOKEN not set');
    return;
  }
  try {
    const res = await fetch(`${UPSTASH_URL}/set/${DATA_KEY}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify(d)
    });
    const json = await res.json();
    if (json.result === 'OK') {
      console.log('Saved to Upstash OK (' + d.tasks.length + ' tasks)');
    } else {
      console.error('Upstash save returned unexpected response:', JSON.stringify(json));
    }
  } catch (e) {
    console.error('Upstash save failed', e);
  }
}

let data = defaultData();
function saveData(d) { persistData(d).catch(() => {}); }

// ---------- date helpers (local calendar dates as YYYY-MM-DD strings) ----------
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function toStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function todayDate() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function todayStr() { return toStr(todayDate()); }
function tomorrowStr() { const d = todayDate(); d.setDate(d.getDate() + 1); return toStr(d); }
function parseStr(s) { const [y, m, dd] = s.split('-').map(Number); return new Date(y, m - 1, dd); }
function addInterval(dateStr, every, unit) {
  const d = parseStr(dateStr);
  if (unit === 'day') d.setDate(d.getDate() + every);
  else if (unit === 'week') d.setDate(d.getDate() + every * 7);
  else if (unit === 'month') d.setMonth(d.getMonth() + every);
  else if (unit === 'year') d.setFullYear(d.getFullYear() + every);
  return toStr(d);
}
function uid() { return 't' + Date.now() + Math.random().toString(36).slice(2, 8); }

function pendingTasks() {
  const t = todayStr();
  return data.tasks.filter(x => !x.done && x.dueDate <= t);
}
function tasksDueTomorrow() {
  const t = tomorrowStr();
  return data.tasks.filter(x => !x.done && x.dueDate === t);
}

// ---------- quiet hours check ----------
function withinActiveHours(now, settings) {
  const hm = pad(now.getHours()) + ':' + pad(now.getMinutes());
  return hm >= settings.quietStart && hm <= settings.quietEnd;
}
function withinWindow(now, targetHM, windowMinutes) {
  const [h, m] = targetHM.split(':').map(Number);
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
  const diffMin = (now - target) / 60000;
  return diffMin >= 0 && diffMin < windowMinutes;
}

// ---------- push sending ----------
async function sendPush(payload) {
  if (!data.subscription) return false;
  try {
    await webpush.sendNotification(data.subscription, JSON.stringify(payload));
    return true;
  } catch (e) {
    console.error('Push failed', e.statusCode || e.message);
    if (e.statusCode === 404 || e.statusCode === 410) {
      data.subscription = null; // subscription expired/revoked, clear it
      saveData(data);
    }
    return false;
  }
}

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
