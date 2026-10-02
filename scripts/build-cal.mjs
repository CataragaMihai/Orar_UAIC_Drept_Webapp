#!/usr/bin/env node
// Writes subscribable calendars to public/cal/<group>/<electives>.ics: one per way
// of choosing one subject from each elective package, plus toate.ics (everything).
// Runs on every deploy; the output isn't committed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildICS, electiveCombos } from '../public/core.js';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = rel => JSON.parse(fs.readFileSync(path.join(PUB, rel), 'utf8'));
const meta = read('data/meta.json');
const OUT = path.join(PUB, 'cal');
fs.rmSync(OUT, { recursive: true, force: true });

let files = 0;
for (const g of read('data/groups.json')) {
  let data;
  try { data = read(`data/groups/${g.id}.json`); } catch { continue; }
  const combos = electiveCombos(data);
  if (combos.length > 1) combos.push({ key: 'toate', hidden: new Set() });
  fs.mkdirSync(path.join(OUT, g.id), { recursive: true });
  for (const c of combos) {
    const { text } = buildICS(meta, data, c.hidden, { name: `Orar ${g.id}`, alarmMinutes: 15 });
    fs.writeFileSync(path.join(OUT, g.id, `${c.key}.ics`), text);
    files++;
  }
}
console.log(`Wrote ${files} calendars.`);
