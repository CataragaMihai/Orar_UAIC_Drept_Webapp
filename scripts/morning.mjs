#!/usr/bin/env node
// Sends each subscriber a push notification with today's classes.
// Subscribers are the codes the app generates (Notificări → Rezumatul de dimineață),
// one per line in the PUSH_SUBSCRIBERS secret.
//
//   node scripts/morning.mjs            sends only between 06:10 and 07:25 Bucharest time
//   node scripts/morning.mjs --force    sends now
//   node scripts/morning.mjs --dry      prints instead of sending (no keys needed)
//   --date YYYY-MM-DD                   summarise another day

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lessonsOn, nowParts, VAPID_PUBLIC } from '../public/core.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;

// GitHub's scheduler runs late, sometimes by half an hour. The workflow fires at
// 03:30 and 04:30 UTC; exactly one of those lands in this window in both summer
// (UTC+3) and winter (UTC+2) time.
const WINDOW = [6 * 60 + 10, 7 * 60 + 25];

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = rel => JSON.parse(fs.readFileSync(path.join(PUB, rel), 'utf8'));

function summary(meta, data, hidden, iso) {
  const { list } = lessonsOn(meta, data, hidden, iso);
  if (!list.length) return null;
  const n = list.length;
  return {
    title: `Azi ai ${n} ${n === 1 ? 'oră' : 'ore'} · ${list[0].start}–${list.at(-1).end}`,
    body: list.map(l => `${l.start} ${l.subject} · ${l.type}${l.room ? ` · ${l.room}` : ''}`).join('\n'),
    tag: `morning-${iso}`,
    url: `./?g=${encodeURIComponent(data.id)}`,
  };
}

async function main() {
  const now = nowParts();
  if (!FORCE && !DRY && !dateArg && (now.min < WINDOW[0] || now.min > WINDOW[1])) {
    console.log(`Outside the morning window (${Math.floor(now.min / 60)}:${String(now.min % 60).padStart(2, '0')} in Bucharest); nothing to do.`);
    return;
  }
  const iso = dateArg || now.iso;
  const codes = (process.env.PUSH_SUBSCRIBERS || '').split(/\s+/).filter(Boolean);
  if (!codes.length) { console.log('No subscribers.'); return; }

  let webpush = null;
  if (!DRY) {
    webpush = (await import('web-push')).default;
    if (!process.env.VAPID_PRIVATE_KEY) throw new Error('VAPID_PRIVATE_KEY is not set');
    webpush.setVapidDetails('https://github.com/CataragaMihai/orar', VAPID_PUBLIC, process.env.VAPID_PRIVATE_KEY);
  }

  const meta = read('data/meta.json');
  let failures = 0;
  for (const [i, code] of codes.entries()) {
    const who = `subscriber ${i + 1}`;
    try {
      const sub = JSON.parse(Buffer.from(code, 'base64').toString('utf8'));
      const msg = summary(meta, read(`data/groups/${sub.g}.json`), new Set(sub.h || []), iso);
      if (!msg) { console.log(`${who} (${sub.g}): no classes on ${iso}`); continue; }
      if (DRY) { console.log(`${who} (${sub.g}):\n${msg.title}\n${msg.body}\n`); continue; }
      await webpush.sendNotification({ endpoint: sub.e, keys: sub.k }, JSON.stringify(msg), { TTL: 3 * 3600, urgency: 'high' });
      console.log(`${who} (${sub.g}): sent "${msg.title}"`);
    } catch (err) {
      failures++;
      const gone = err.statusCode === 404 || err.statusCode === 410;
      console.log(`${who}: ${gone ? 'subscription expired; ask for a new code from the app' : err.message}`);
    }
  }
  if (failures === codes.length) process.exit(1);
}

main().catch(err => { console.error(`morning: ${err.message}`); process.exit(1); });
