#!/usr/bin/env node
// Scrapes an eOra-generated timetable site (e.g. UAIC Faculty of Law) into JSON
// that the web app reads. Zero dependencies; needs Node 18+ for fetch.
//
//   node scripts/scrape.mjs            only re-downloads when the site has a new publish stamp
//   node scripts/scrape.mjs --force    always re-download
//
// Output (public/data/):
//   meta.json          title, publish stamp, validity, teaching weeks, free days
//   groups.json        every student group with its category path
//   groups/<id>.json   that group's weekly and one-off classes
//   changes.json       the site's "latest changes" log

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.EORA_BASE || 'https://laws.uaic.ro/os1v42627').replace(/\/$/, '');
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const FORCE = process.argv.includes('--force');
const DELAY_MS = 400; // be polite: one request at a time, with a pause between them

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(rel) {
  const url = `${BASE}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'orar-app (personal timetable viewer)' },
        signal: AbortSignal.timeout(30e3),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(2000 * attempt);
    }
  }
}

// ---- HTML helpers (the markup is machine-generated and very regular) ---------
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&(\w+);/g, (m, n) => ENTITIES[n] ?? m);
const text = s => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const rows = html => [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map(m => m[0]); // whole row, tag included
const cells = (tr, tag) => [...tr.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map(m => m[1]);
const attr = (s, name) => (s.match(new RegExp(`${name}="([^"]*)"`)) || [])[1];

const roDate = s => { const [d, m, y] = s.split('.'); return `${y}-${m}-${d}`; };
const DATE = /(\d{2}\.\d{2}\.\d{4})/;

function published(html) {
  const m = html.match(/Publicat la data\s*<b>\s*([\d.]+\s+[\d:]+)/) || html.match(/Data afișării:\s*([\d.,\s:]+)/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function validity(html) {
  const m = html.match(/valabil în perioada\s*<b>\s*(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})/);
  return m ? { from: roDate(m[1]), to: roDate(m[2]) } : null;
}

// "08-10" -> 08:00/10:00, "9:30-11" -> 09:30/11:00
function interval(s) {
  const m = s.match(/(\d{1,2})(?:[:.](\d{2}))?\s*-\s*(\d{1,2})(?:[:.](\d{2}))?/);
  if (!m) return null;
  const t = (h, mm) => `${h.padStart(2, '0')}:${mm || '00'}`;
  return { start: t(m[1], m[2]), end: t(m[3], m[4]) };
}

// "1-7, 9" -> [1..7, 9]
function weekList(s) {
  if (!s) return null;
  const out = [];
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const r = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!r) return null;
    for (let i = +r[1]; i <= +(r[2] || r[1]); i++) out.push(i);
  }
  return out.length ? out : null;
}

const DAYS = { luni: 1, marti: 2, miercuri: 3, joi: 4, vineri: 5, sambata: 6, duminica: 0 };
const dayKey = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const FREQ = { pare: 'even', impare: 'odd' };

// ---- Pages -------------------------------------------------------------------
function parseGroups(html) {
  const seen = new Map();
  for (const m of html.matchAll(/<a href="participanti\/orar_([^"]+)\.html" title="([^"]*)">([\s\S]*?)<\/a>/g)) {
    const id = decode(m[1]);
    const crumbs = decode(m[2]).split(',').map(s => s.trim()).filter(Boolean);
    if (crumbs[0] === 'Studenti') crumbs.shift();
    seen.set(id, { id, name: text(m[3]), path: crumbs.slice(0, -1) });
  }
  return [...seen.values()];
}

function parseGroupPage(html) {
  const title = text((html.match(/<h2>([\s\S]*?)<\/h2>/) || ['', ''])[1]).replace(/^Orar\s+/, '');
  const weekly = [], unique = [];
  let headers = null, unique_ = false, day = null, date = null;

  for (const tr of rows(html)) {
    const th = cells(tr, 'th');
    if (th.length) {
      headers = th.map(text);
      unique_ = /th-unique/.test(tr);
      continue;
    }
    const td = cells(tr, 'td');
    if (td.length === 1) { // section row: "Luni (8 ore)" or "Vineri , 02.10.2026"
      const t = text(td[0]);
      const d = t.match(DATE);
      date = d ? roDate(d[1]) : null;
      const k = dayKey(t.split(/[\s,(]/)[0]);
      day = k in DAYS ? DAYS[k] : null;
      continue;
    }
    if (!headers || td.length !== headers.length) continue;

    const col = name => {
      const i = headers.indexOf(name);
      return i === -1 ? '' : text(td[i]);
    };
    const time = interval(col('Interval'));
    if (!time) continue;
    const roomCell = td[headers.indexOf('Sala')] || '';
    const lesson = {
      ...time,
      subject: col('Disciplina'),
      type: col('Tip'),
      teacher: col('Profesor'),
      room: col('Sala'),
      building: attr(roomCell, 'title') || null,
      freq: FREQ[dayKey(col('Frecvența'))] || null,
      pkg: col('Pachet') || null,
      weeks: weekList(col('Săpt.')),
    };
    if (headers.includes('Grupa')) lesson.subgroup = col('Grupa') || null;
    if (col('Săpt.') && !lesson.weeks) lesson.weeksRaw = col('Săpt.');

    if (unique_) { if (date) unique.push({ date, ...lesson }); }
    else if (day != null) weekly.push({ day, ...lesson });
  }
  return { title, weekly, unique };
}

function parseCalendar(html) {
  const [weeksCol = '', freeCol = ''] = cells(html.split('</th>').slice(-1)[0] || '', 'td');
  const weeks = [...weeksCol.matchAll(/<b>(\d+)<\/b>:\s*(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})/g)]
    .map(m => ({ n: +m[1], start: roDate(m[2]), end: roDate(m[3]) }));
  const freeDays = [...freeCol.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(m => {
    const t = text(m[1]);
    const d = [...t.matchAll(/\d{2}\.\d{2}\.\d{4}/g)].map(x => roDate(x[0]));
    return d.length ? { start: d[0], end: d[1] || d[0], label: t.replace(/[\d.\s-]+:?/, '').trim() || null } : null;
  }).filter(Boolean);
  return { weeks, freeDays };
}

function parseChanges(html) {
  const out = [];
  let at = null;
  for (const tr of rows(html)) {
    const td = cells(tr, 'td');
    if (td.length === 1) {
      const m = text(td[0]).match(/(\d{2}\.\d{2}\.\d{4})\s*([\d:]*)/);
      if (m) at = `${roDate(m[1])}${m[2] ? `T${m[2]}` : ''}`;
    } else if (td.length >= 4 && at) {
      out.push({
        at,
        subject: text(td[0]),
        groups: [...td[1].matchAll(/orar_([^"]+)\.html/g)].map(g => decode(g[1])),
        teacher: text(td[2]),
        text: text(td[3]),
      });
    }
  }
  return out;
}

// ---- Main ----------------------------------------------------------------------
function writeJSON(rel, data) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(data, null, 1) + '\n';
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) return false;
  fs.writeFileSync(file + '.tmp', body);
  fs.renameSync(file + '.tmp', file);
  return true;
}

async function main() {
  // The groups page carries the publish stamp, so it doubles as the "anything new?" check.
  const studentsHtml = await get('orar_studenti.html');
  const stamp = published(studentsHtml);
  let old = null;
  try { old = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json'), 'utf8')); } catch {}
  if (!FORCE && old && stamp && old.published === stamp) {
    console.log(`Unchanged since ${stamp}; nothing to do.`);
    return;
  }

  await sleep(DELAY_MS);
  const index = await get('index.html'); await sleep(DELAY_MS);
  const title = text((index.match(/<title>([\s\S]*?)<\/title>/) || ['', ''])[1]);
  const faculty = (text(index.replace(/<style[\s\S]*?<\/style>/g, '')).match(/Facultatea .*?(?= Studenți)/) || [null])[0];
  const calendar = parseCalendar(await get('calendar.html')); await sleep(DELAY_MS);
  const changes = parseChanges(await get('modificari.html')); await sleep(DELAY_MS);
  const groups = parseGroups(studentsHtml);
  if (!groups.length) throw new Error('no groups found on orar_studenti.html; has the layout changed?');
  if (!calendar.weeks.length) throw new Error('no teaching weeks found on calendar.html');

  let total = 0;
  const failed = [];
  for (const g of groups) {
    try {
      const page = parseGroupPage(await get(`participanti/orar_${g.id}.html`));
      g.title = page.title;
      g.count = page.weekly.length + page.unique.length;
      total += g.count;
      writeJSON(`groups/${g.id}.json`, { id: g.id, ...page });
    } catch (err) {
      failed.push(`${g.id}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }
  if (failed.length > groups.length / 4) throw new Error(`too many groups failed:\n${failed.join('\n')}`);

  writeJSON('groups.json', groups);
  writeJSON('changes.json', changes);
  // eOra's own calendar marks every week as a teaching week, so holidays and exam
  // sessions come from the university's academic-year structure instead.
  let year = {};
  try { year = JSON.parse(fs.readFileSync(path.join(OUT, '..', '..', 'academic-year.json'), 'utf8')); } catch {}
  writeJSON('meta.json', {
    source: BASE,
    teaching: year.teaching || null,
    periods: year.periods || [],
    title, faculty,
    published: stamp,
    valid: validity(studentsHtml),
    scrapedAt: new Date().toISOString(),
    ...calendar,
  });
  console.log(`Published ${stamp}: ${groups.length} groups, ${total} classes, ${changes.length} changes.` +
    (failed.length ? `\nFailed: ${failed.join('; ')}` : ''));
}

main().catch(err => { console.error(`scrape: ${err.message}`); process.exit(1); });
