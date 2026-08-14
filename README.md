# OPH Edina Waitlist Tracker

Samples the live waitlist (status, parties ahead, quoted wait range) for the
Original Pancake House in Edina, MN (3501 W 70th St) once per minute during
open hours (6:30 AM–3:00 PM CT), 2026-08-14 through 2026-08-21.

The restaurant's waitlist runs on Toast (`toast.app/r/oph-edina`). Toast's API
rejects non-browser HTTP clients, so `collector.mjs` drives a real Chrome via
the DevTools protocol: it reloads the restaurant page each minute and records
the waitlist estimate from the page's own network traffic.

- `collector.mjs` — the sampler (runs locally on Windows and in CI on Linux)
- `.github/workflows/collect.yml` — GitHub Actions runs: two jobs/day covering
  06:00–10:30 and 10:30–15:30 CT, committing `data/waitlist_log_ci.csv`
- A parallel local collector (Windows Task Scheduler) writes `waitlist_log.csv`
  on the collection machine; the two logs are merged by timestamp at analysis time

CSV columns: `ts_ct, ts_utc, waitlist_status, parties_ahead, wait_min_minutes,
wait_max_minutes, party_size, source, note`
