'use strict';
// Orar: reads the JSON written by scripts/scrape.mjs and shows one group's classes
// by day. Odd/even weeks come from the faculty's own calendar (meta.weeks).

const TZ = 'Europe/Bucharest';
const DAY_NAMES = ['Duminică', 'Luni', 'Marți', 'Miercuri', 'Joi', 'Vineri', 'Sâmbătă'];
const DAY_SHORT = ['Du', 'Lu', 'Ma', 'Mi', 'Jo', 'Vi', 'Sâ'];
const MONTHS = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie',
  'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
const MON_SHORT = ['ian', 'feb', 'mar', 'apr', 'mai', 'iun', 'iul', 'aug', 'sep', 'oct', 'noi', 'dec'];

const $ = id => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k);
  return n;
};

// Browser storage is a convenience: the app still works if it is blocked.
const store = {
  get(k, fallback = null) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---- Dates: ISO strings, arithmetic on UTC midnight ---------------------------
const toDate = iso => new Date(iso + 'T00:00:00Z');
const toISO = d => d.toISOString().slice(0, 10);
const addDays = (iso, n) => toISO(new Date(toDate(iso).getTime() + n * 864e5));
const dow = iso => toDate(iso).getUTCDay();
const mondayOf = iso => addDays(iso, -((dow(iso) + 6) % 7));
const nowParts = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { iso: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
};
const mins = hhmm => { const [h, m] = hhmm.split(':'); return +h * 60 + +m; };
const longDate = iso => { const d = toDate(iso); return `${DAY_NAMES[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const shortDate = iso => { const d = toDate(iso); return `${d.getUTCDate()} ${MON_SHORT[d.getUTCMonth()]}`; };

// ---- State ---------------------------------------------------------------------
const S = {
  meta: null, groups: [], changes: [], data: null,
  groupId: null, hidden: new Set(), // subjects from elective packages she doesn't take
  selected: null, weekStart: null,
};

async function getJSON(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

const weekOf = iso => S.meta.weeks.find(w => w.start <= iso && iso <= w.end) || null;
const freeDay = iso => S.meta.freeDays.find(f => f.start <= iso && iso <= f.end) || null;
const parityOf = n => (n % 2 === 0 ? 'even' : 'odd');

function packages() {
  const pk = new Map();
  for (const l of [...S.data.weekly, ...S.data.unique]) {
    if (!l.pkg) continue;
    if (!pk.has(l.pkg)) pk.set(l.pkg, new Set());
    pk.get(l.pkg).add(l.subject);
  }
  return [...pk.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ro', { numeric: true }))
    .map(([id, subs]) => ({ id, subjects: [...subs].sort((a, b) => a.localeCompare(b, 'ro')) }));
}

function lessonsOn(iso) {
  if (!S.data) return { list: [], reason: null };
  const v = S.meta.valid;
  if (v && (iso < v.from || iso > v.to)) return { list: [], reason: 'out' };
  const week = weekOf(iso);
  const period = (S.meta.periods || []).find(p => p.start <= iso && iso <= p.end) || null;
  const teaching = !S.meta.teaching || S.meta.teaching.some(t => t.start <= iso && iso <= t.end);
  const free = freeDay(iso) || (!teaching && (period || { label: null }));
  const keep = l => !S.hidden.has(l.subject);
  const weekly = week && !free
    ? S.data.weekly.filter(l => l.day === dow(iso)
      && (!l.freq || l.freq === parityOf(week.n))
      && (!l.weeks || l.weeks.includes(week.n)))
    : [];
  const unique = S.data.unique.filter(l => l.date === iso);
  const list = [...weekly, ...unique].filter(keep).sort((a, b) => a.start.localeCompare(b.start));
  return { list, reason: !week ? 'vacation' : !teaching && !period ? 'out' : free ? 'free' : null, free };
}

// ---- Rendering --------------------------------------------------------------------
function typeClass(t) {
  const k = t.toLowerCase();
  return k.startsWith('curs') ? 'curs' : k.startsWith('seminar') ? 'seminar' : 'other';
}

function renderHeader() {
  const w = weekOf(S.selected);
  const off = lessonsOn(S.selected);
  const period = off.reason === 'free' && !freeDay(S.selected) ? off.free.label : null;
  $('week-label').textContent = period || (w ? `Săptămâna ${w.n}` : 'Vacanță');
  $('week-sub').textContent = w && !period
    ? `${w.n % 2 === 0 ? 'pară' : 'impară'} · ${shortDate(S.weekStart)} – ${shortDate(addDays(S.weekStart, 6))}`
    : `${shortDate(S.weekStart)} – ${shortDate(addDays(S.weekStart, 6))}`;
  $('group-btn').textContent = S.groupId || 'Alege grupa';

  const today = nowParts().iso;
  const days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(S.weekStart, i))
    .filter(iso => dow(iso) !== 0 || lessonsOn(iso).list.length);
  $('days').style.gridTemplateColumns = `repeat(${days.length}, 1fr)`;
  $('days').replaceChildren(...days.map(iso => {
    const n = lessonsOn(iso).list.length;
    return el('button', {
      class: `day${iso === today ? ' today' : ''}${n ? '' : ' off'}`, type: 'button',
      'aria-pressed': String(iso === S.selected), 'aria-label': `${longDate(iso)}, ${n} ore`,
      onclick: () => { S.selected = iso; render(); },
    },
    el('span', { class: 'dn' }, DAY_SHORT[dow(iso)]),
    el('span', { class: 'dd' }, String(toDate(iso).getUTCDate())),
    el('span', { class: 'dots' }, Array.from({ length: Math.min(n, 5) }, () => el('i'))));
  }));
}

function renderDay() {
  const { iso: today, min: nowMin } = nowParts();
  const iso = S.selected;
  const rel = iso === today ? 'Astăzi · ' : iso === addDays(today, 1) ? 'Mâine · ' : iso === addDays(today, -1) ? 'Ieri · ' : '';
  $('day-title').textContent = rel + longDate(iso);

  const { list, reason, free } = lessonsOn(iso);
  if (!S.data) { $('lessons').replaceChildren(); return; }
  if (!list.length) {
    const msg = reason === 'vacation' ? ['Vacanță', 'Nu e săptămână de cursuri.']
      : reason === 'free' ? [free.label || 'Zi liberă', 'Fără cursuri săptămânale.']
      : reason === 'out' ? ['În afara semestrului', '']
      : [dow(iso) === 0 || dow(iso) === 6 ? 'Weekend liber' : 'Nicio oră', nextClassText(iso)];
    $('lessons').replaceChildren(el('li', { class: 'empty' }, el('b', {}, msg[0]), msg[1]));
    return;
  }
  const isToday = iso === today;
  let nextMarked = false;
  $('lessons').replaceChildren(...list.map(l => {
    const s = mins(l.start), e = mins(l.end);
    const past = isToday && e <= nowMin;
    const live = isToday && s <= nowMin && nowMin < e;
    let soon = null;
    if (isToday && !nextMarked && s > nowMin) {
      nextMarked = true;
      const d = s - nowMin;
      if (d <= 120) soon = d < 60 ? `în ${d} min` : `în ${Math.floor(d / 60)} h ${d % 60 ? `${d % 60} min` : ''}`.trim();
    }
    return el('li', { class: `lesson${past ? ' past' : ''}${live ? ' now' : ''}` },
      el('div', { class: 'time' }, l.start, el('span', {}, l.end)),
      el('div', {},
        el('div', { class: 'subj' }, l.subject),
        el('div', { class: 'meta' },
          live && el('span', { class: 'tag live' }, 'Acum'),
          soon && el('span', { class: 'tag live' }, soon),
          el('span', { class: `tag ${typeClass(l.type)}` }, l.type),
          l.pkg && el('span', { class: 'tag elective' }, 'opțional'),
          l.date && el('span', { class: 'tag other' }, 'o singură dată'),
          l.room && el('span', { class: 'room' }, l.room)),
        el('div', { class: 'who' }, [l.teacher, l.building, l.subgroup && `cu ${l.subgroup}`].filter(Boolean).join(' · '))));
  }));
}

function nextClassText(iso) {
  for (let i = 1; i <= 21; i++) {
    const d = addDays(iso, i);
    const { list } = lessonsOn(d);
    if (list.length) return `Următoarea: ${DAY_NAMES[dow(d)].toLowerCase()} ${shortDate(d)}, ${list[0].start} · ${list[0].subject}`;
  }
  return '';
}

function renderBanner() {
  const pk = S.data ? packages() : [];
  const seen = store.get(`orar.electivesSeen.${S.groupId}`, false);
  $('electives-btn').hidden = !pk.length;
  if (!S.groupId) {
    $('banner').replaceChildren(el('div', { class: 'banner' }, 'Alege-ți grupa ca să vezi orarul.',
      el('button', { type: 'button', onclick: openGroups }, 'Alege')));
  } else if (pk.length && !seen) {
    $('banner').replaceChildren(el('div', { class: 'banner' }, 'Ai materii opționale. Alege-le pe ale tale ca să nu apară toate.',
      el('button', { type: 'button', onclick: openElectives }, 'Alege')));
  } else $('banner').replaceChildren();
}

function renderChanges() {
  const mine = S.changes.filter(c => c.groups.includes(S.groupId) && !S.hidden.has(c.subject)).slice(0, 6);
  const sec = $('changes');
  sec.hidden = !mine.length;
  if (!mine.length) return;
  const lastSeen = store.get(`orar.changesSeen.${S.groupId}`, '');
  sec.replaceChildren(
    el('h3', {}, 'Modificări recente pentru grupa ta'),
    el('ul', {}, mine.map(c => el('li', { class: c.at > lastSeen && lastSeen ? 'new' : '' },
      el('b', {}, c.subject), ': ', c.text,
      el('small', {}, `${shortDate(c.at.slice(0, 10))} · ${c.teacher}`)))));
  store.set(`orar.changesSeen.${S.groupId}`, mine[0].at);
}

function renderFooter() {
  const m = S.meta;
  $('updated').replaceChildren(
    `Orar publicat ${m.published || '—'} · verificat ${new Date(m.scrapedAt).toLocaleString('ro-RO', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' })} · `,
    el('a', { href: S.groupId ? `${m.source}/participanti/orar_${encodeURIComponent(S.groupId)}.html` : m.source, target: '_blank', rel: 'noopener' }, 'sursa'));
  $('ics-btn').hidden = !S.data;
}

function render() {
  S.weekStart = mondayOf(S.selected);
  renderHeader();
  renderBanner();
  renderDay();
  renderFooter();
}

// ---- Sheets ---------------------------------------------------------------------------
function openSheet(title, body) {
  $('sheet-title').textContent = title;
  $('sheet-body').replaceChildren(...body);
  const d = $('sheet');
  if (!d.open) d.showModal();
}

function openGroups() {
  const list = el('div');
  const draw = q => {
    const norm = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const byPath = new Map();
    for (const g of S.groups) {
      if (q && !norm(`${g.id} ${g.name} ${g.path.join(' ')}`).includes(norm(q))) continue;
      const k = g.path.join(' · ') || 'Grupe';
      if (!byPath.has(k)) byPath.set(k, []);
      byPath.get(k).push(g);
    }
    list.replaceChildren(...[...byPath].flatMap(([k, gs]) => [
      el('h4', {}, k),
      el('div', { class: 'opts' }, gs.sort((a, b) => a.name.localeCompare(b.name, 'ro', { numeric: true })).map(g => el('button', {
        class: 'opt', type: 'button', 'aria-pressed': String(g.id === S.groupId),
        onclick: () => { $('sheet').close(); selectGroup(g.id); },
      }, g.name))),
    ]));
  };
  const search = el('input', { class: 'search', type: 'search', placeholder: 'Caută (ex: 1A6)', oninput: e => draw(e.target.value) });
  draw('');
  openSheet('Alege grupa', [search, list]);
}

function openElectives() {
  const pk = packages();
  const body = [el('p', { class: 'help' }, 'Bifează doar materiile pe care le urmezi. Celelalte dispar din orar.')];
  for (const p of pk) {
    body.push(el('h4', {}, `Pachet ${p.id}`));
    body.push(el('div', { class: 'opts' }, p.subjects.map(sub => el('button', {
      class: 'opt', type: 'button', 'aria-pressed': String(!S.hidden.has(sub)),
      onclick: e => {
        if (S.hidden.has(sub)) S.hidden.delete(sub); else S.hidden.add(sub);
        e.currentTarget.setAttribute('aria-pressed', String(!S.hidden.has(sub)));
        store.set(`orar.hidden.${S.groupId}`, [...S.hidden]);
        render();
        renderChanges();
      },
    }, sub))));
  }
  store.set(`orar.electivesSeen.${S.groupId}`, true);
  openSheet('Opționale', body);
  renderBanner();
}

// ---- Calendar export (.ics) ---------------------------------------------------------
function buildICS() {
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/[;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
  const fold = line => line.length <= 60 ? line : line.match(/.{1,60}/gu).join('\r\n ');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const dt = (iso, hhmm) => `${iso.replace(/-/g, '')}T${hhmm.replace(':', '')}00`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//orar-app//RO', 'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:Orar ${S.groupId}`, `X-WR-TIMEZONE:${TZ}`,
    'BEGIN:VTIMEZONE', `TZID:${TZ}`,
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0300', 'TZNAME:EEST', 'DTSTART:19700329T030000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0200', 'TZNAME:EET', 'DTSTART:19701025T040000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE',
  ];
  const from = S.meta.valid?.from || S.meta.weeks[0].start;
  const to = S.meta.teaching?.at(-1)?.end || S.meta.valid?.to || S.meta.weeks.at(-1).end;
  let count = 0;
  for (let iso = from; iso <= to; iso = addDays(iso, 1)) {
    for (const l of lessonsOn(iso).list) {
      count++;
      lines.push('BEGIN:VEVENT',
        `UID:${S.groupId}-${iso}-${l.start}-${count}@orar-app`,
        `DTSTAMP:${stamp}`,
        `DTSTART;TZID=${TZ}:${dt(iso, l.start)}`,
        `DTEND;TZID=${TZ}:${dt(iso, l.end)}`,
        `SUMMARY:${esc(`${l.subject} (${l.type})`)}`,
        `LOCATION:${esc([l.room, l.building].filter(Boolean).join(', '))}`,
        `DESCRIPTION:${esc(l.teacher)}`,
        'END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return { text: lines.map(fold).join('\r\n') + '\r\n', count };
}

function downloadICS() {
  const { text, count } = buildICS();
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const a = el('a', { href: url, download: `orar-${S.groupId}.ics` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10e3);
  $('ics-btn').textContent = `${count} ore exportate. Dacă orarul se schimbă, exportă din nou.`;
}

// ---- Boot -------------------------------------------------------------------------------
async function selectGroup(id) {
  S.groupId = id;
  store.set('orar.group', id);
  S.hidden = new Set(store.get(`orar.hidden.${id}`, []));
  S.data = null;
  try {
    S.data = await getJSON(`data/groups/${encodeURIComponent(id)}.json`);
  } catch (err) {
    $('lessons').replaceChildren(el('li', { class: 'empty' }, el('b', {}, 'Nu am putut încărca orarul'), err.message));
  }
  render();
  renderChanges();
  if (S.data && packages().length && !store.get(`orar.electivesSeen.${id}`, false)) openElectives();
}

async function boot() {
  [S.meta, S.groups, S.changes] = await Promise.all([
    getJSON('data/meta.json'), getJSON('data/groups.json'), getJSON('data/changes.json').catch(() => []),
  ]);
  const today = nowParts().iso;
  S.selected = dow(today) === 0 ? addDays(today, 1) : today; // Sunday: show Monday

  $('group-btn').onclick = openGroups;
  $('electives-btn').onclick = openElectives;
  $('ics-btn').onclick = downloadICS;
  $('prev-week').onclick = () => { S.selected = addDays(S.selected, -7); render(); };
  $('next-week').onclick = () => { S.selected = addDays(S.selected, 7); render(); };

  // A shared link like ?g=1A6 picks the group.
  const fromUrl = new URLSearchParams(location.search).get('g');
  const id = [fromUrl, store.get('orar.group')].find(g => g && S.groups.some(x => x.id === g));
  if (id) await selectGroup(id);
  else { render(); openGroups(); }

  // Keep "Acum" / "în 10 min" current, and roll over at midnight.
  setInterval(() => { if (!$('sheet').open) render(); }, 60e3);
}

boot().catch(err => {
  document.querySelector('main').replaceChildren(el('div', { class: 'empty' }, el('b', {}, 'Ceva n-a mers'), err.message));
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
