// Timetable logic shared by the web app (browser) and the workflows (Node):
// which classes fall on a date, elective packages, and calendar (.ics) output.
// Pure functions over the JSON written by scripts/scrape.mjs.

export const TZ = 'Europe/Bucharest';
// Public half of the web-push key pair; the private half is a GitHub secret.
export const VAPID_PUBLIC = 'BIkTLsAtp2wcycMv5WEJO24CYc8feYuW0gOxhs6NZ7lNG3MLM2m4iQJE1Js4DIPjBzl9BnxWaEa_oWcNYnbfnHI';

// ---- Dates: ISO strings, arithmetic on UTC midnight ---------------------------
export const toDate = iso => new Date(iso + 'T00:00:00Z');
export const toISO = d => d.toISOString().slice(0, 10);
export const addDays = (iso, n) => toISO(new Date(toDate(iso).getTime() + n * 864e5));
export const dow = iso => toDate(iso).getUTCDay();
export const mondayOf = iso => addDays(iso, -((dow(iso) + 6) % 7));
export const mins = hhmm => { const [h, m] = hhmm.split(':'); return +h * 60 + +m; };
export function nowParts(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { iso: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

// ---- Which classes happen on a date ------------------------------------------------
export const weekOf = (meta, iso) => meta.weeks.find(w => w.start <= iso && iso <= w.end) || null;
export const freeDay = (meta, iso) => meta.freeDays.find(f => f.start <= iso && iso <= f.end) || null;
const parityOf = n => (n % 2 === 0 ? 'even' : 'odd');

// reason: null (normal day), 'free' (holiday / exam session; `free.label` says which),
// 'vacation' (no eOra week), 'out' (outside the semester).
export function lessonsOn(meta, data, hidden, iso) {
  const v = meta.valid;
  if (v && (iso < v.from || iso > v.to)) return { list: [], reason: 'out' };
  const week = weekOf(meta, iso);
  const period = (meta.periods || []).find(p => p.start <= iso && iso <= p.end) || null;
  const teaching = !meta.teaching || meta.teaching.some(t => t.start <= iso && iso <= t.end);
  const free = freeDay(meta, iso) || (!teaching && (period || { label: null }));
  const weekly = week && !free
    ? data.weekly.filter(l => l.day === dow(iso)
      && (!l.freq || l.freq === parityOf(week.n))
      && (!l.weeks || l.weeks.includes(week.n)))
    : [];
  const unique = data.unique.filter(l => l.date === iso);
  const list = [...weekly, ...unique].filter(l => !hidden.has(l.subject))
    .sort((a, b) => a.start.localeCompare(b.start));
  return { list, reason: !week ? 'vacation' : !teaching && !period ? 'out' : free ? 'free' : null, free };
}

// ---- Elective packages ----------------------------------------------------------------
export function packages(data) {
  const pk = new Map();
  for (const l of [...data.weekly, ...data.unique]) {
    if (!l.pkg) continue;
    if (!pk.has(l.pkg)) pk.set(l.pkg, new Set());
    pk.get(l.pkg).add(l.subject);
  }
  return [...pk.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ro', { numeric: true }))
    .map(([id, subs]) => ({ id, subjects: [...subs].sort((a, b) => a.localeCompare(b, 'ro')) }));
}

export const slug = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Every way of choosing exactly one subject per package, as { key, hidden }.
// The key names the published calendar file: cal/<group>/<key>.ics
export function electiveCombos(data) {
  const pk = packages(data);
  let combos = [{ picks: [], hidden: new Set() }];
  for (const p of pk) {
    combos = combos.flatMap(c => p.subjects.map(pick => ({
      picks: [...c.picks, pick],
      hidden: new Set([...c.hidden, ...p.subjects.filter(s => s !== pick)]),
    })));
  }
  return combos.map(c => ({ key: c.picks.length ? c.picks.map(slug).join('_') : 'toate', hidden: c.hidden }));
}

// The calendar file matching a set of hidden subjects, or 'toate' (everything)
// when the choice isn't exactly one subject per package.
export function calKey(data, hidden) {
  const picks = [];
  for (const p of packages(data)) {
    const kept = p.subjects.filter(s => !hidden.has(s));
    if (kept.length !== 1) return 'toate';
    picks.push(kept[0]);
  }
  return picks.length ? picks.map(slug).join('_') : 'toate';
}

// ---- Calendar (.ics) ------------------------------------------------------------------------
const hash = s => { let h = 5381; for (const c of s) h = (h * 33 + c.codePointAt(0)) >>> 0; return h.toString(36); };

export function buildICS(meta, data, hidden, { name, alarmMinutes = null, now = new Date() } = {}) {
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/[;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
  const fold = line => line.length <= 60 ? line : line.match(/.{1,60}/gu).join('\r\n ');
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const dt = (iso, hhmm) => `${iso.replace(/-/g, '')}T${hhmm.replace(':', '')}00`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//orar-app//RO', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`, `X-WR-TIMEZONE:${TZ}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT3H', 'X-PUBLISHED-TTL:PT3H',
    'BEGIN:VTIMEZONE', `TZID:${TZ}`,
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0300', 'TZNAME:EEST', 'DTSTART:19700329T030000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0200', 'TZNAME:EET', 'DTSTART:19701025T040000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE',
  ];
  const from = meta.valid?.from || meta.weeks[0].start;
  const to = meta.teaching?.at(-1)?.end || meta.valid?.to || meta.weeks.at(-1).end;
  let count = 0;
  for (let iso = from; iso <= to; iso = addDays(iso, 1)) {
    for (const l of lessonsOn(meta, data, hidden, iso).list) {
      count++;
      lines.push('BEGIN:VEVENT',
        `UID:${data.id}-${iso}-${l.start}-${hash(l.subject + l.type)}@orar-app`,
        `DTSTAMP:${stamp}`,
        `DTSTART;TZID=${TZ}:${dt(iso, l.start)}`,
        `DTEND;TZID=${TZ}:${dt(iso, l.end)}`,
        `SUMMARY:${esc(`${l.subject} (${l.type})`)}`,
        `LOCATION:${esc([l.room, l.building].filter(Boolean).join(', '))}`,
        `DESCRIPTION:${esc(l.teacher)}`);
      if (alarmMinutes != null) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(`${l.subject} · ${l.room || ''}`)}`,
          `TRIGGER:-PT${alarmMinutes}M`, 'END:VALARM');
      }
      lines.push('END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return { text: lines.map(fold).join('\r\n') + '\r\n', count };
}
