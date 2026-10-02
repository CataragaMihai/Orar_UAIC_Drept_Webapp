# Orar

A phone-friendly timetable for UAIC Faculty of Law students, built from the
faculty's public eOra pages (https://laws.uaic.ro/os1v42627/).

- `scripts/scrape.mjs` downloads the group pages, calendar and change log into
  `public/data/`. It skips the download when the faculty hasn't republished.
- `public/` is a static web app (installable, works offline). Pick a group,
  tick your electives, and it shows each day with odd/even weeks resolved.
  `?g=1A6` in the URL preselects a group.
- `academic-year.json` holds holidays and exam sessions, which eOra's calendar
  doesn't mark. Update it every academic year from the university's
  "Structura anului universitar".
- `.github/workflows/update.yml` re-scrapes every 3 hours and redeploys to
  GitHub Pages.

Run locally:

    node scripts/scrape.mjs --force
    python3 -m http.server -d public 8765

Any other faculty that publishes with eOra should work by setting `EORA_BASE`.
