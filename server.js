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
  return diffMin >= 0 && diffMin <