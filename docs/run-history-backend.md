# Run history: backend persistence — change, migration & infra guide

This document describes the move of test-run history from browser
`localStorage` to a server-side **SQLite** store, and everything you need to
upgrade, migrate, deploy, and operate it.

---

## 1. What changed and why

**Before.** Each finished run was serialized to the browser's `localStorage`.
The backend built the report in memory and forgot it.

Limitations: history was tied to one browser on one machine; clearing site data
wiped it; two people testing the same fleet saw different histories; a run lost
its record if the tab closed mid-run; and there was no way to query across runs
(e.g. "all runs for this model").

**After.** The **backend persists every run to SQLite the moment it finishes**,
keyed by camera. The UI reads history from the backend. Benefits:

- History survives browser/device changes and is shared by everyone hitting the
  backend.
- Runs are captured even if the browser closed — persistence happens server-side
  at run completion, not via a client round-trip.
- History is queryable: filter by **model** or **individual camera**, page
  through runs, and render a **trend matrix** (per-test pass/fail across recent
  runs) to spot regressions.
- Reports have stable permalinks: `GET /api/history/{run_id}`.

**Storage choice.** Stdlib `sqlite3` — one file, zero services, transactional,
and it answers "distinct models / filter by camera" in plain SQL. No new Python
dependency (consistent with the project's minimal-deps ethos). Postgres was
rejected as overkill for a single-node LAN tool; flat JSON files were rejected
because filtering/grouping would mean loading everything into memory.

---

## 2. Architecture

```
Run finishes (engine worker thread)
        │
        ▼
engine.store.save_run(report, connection)     ← auto-persist, server-side
        │
        ▼
SQLite (backend/data/onvif_console.db)
   cameras ─┬─< runs (report_json + summary columns)
        ▲
        │  REST
   ┌────┴─────────────────────────────────────────┐
   │ GET /api/history            (paged summaries) │
   │ GET /api/history/cameras    (filter source)   │
   │ GET /api/history/trend      (regression view) │
   │ GET/DELETE /api/history/{id}                  │
   │ POST /api/history/import    (migration)       │
   └───────────────────────────────────────────────┘
        ▲
        │
   history page (filter + pagination + trend) · report page (by id)
```

Concurrency: a run persists from a worker thread while the API reads from the
event-loop thread. A single shared connection (`check_same_thread=False`) guarded
by one `threading.Lock` serializes all access; WAL journal mode is enabled.

---

## 3. Data model

```sql
cameras
  camera_key    TEXT PRIMARY KEY   -- "serial:<n>" when reported, else "host:<ip>:<port>"
  manufacturer  TEXT
  model         TEXT
  serial        TEXT
  last_firmware TEXT
  last_host     TEXT
  first_seen    REAL
  last_seen     REAL

runs
  run_id       TEXT PRIMARY KEY
  camera_key   TEXT REFERENCES cameras(camera_key) ON DELETE CASCADE
  started_at   REAL
  finished_at  REAL
  duration_ms  INTEGER
  passed / failed / skipped / error / total  INTEGER   -- executed tests only
  report_json  TEXT               -- full report, for the report page
```

**Camera identity.** `camera_key` is the ONVIF **serial number** when the camera
reports a non-trivial one, otherwise `host:port`. This keeps one physical camera
as a single history entry across IP changes. Two units of the same model stay
distinct (different serials); a model-only view aggregates across units.

`total` counts executed tests (passed+failed+skipped+error), so a partial run of
3 tests reads "3", not the full suite size.

---

## 4. API reference

| Method & path | Purpose |
|---------------|---------|
| `GET /api/history?camera_key=&model=&limit=&offset=` | paged run summaries (newest first), `limit`≤500 |
| `GET /api/history/cameras` | distinct cameras with run counts + last-tested — powers the filter |
| `GET /api/history/trend?camera_key=&model=&limit=` | canonical test list + per-test status per recent run, `limit`≤100 |
| `GET /api/history/{run_id}` | full stored report (report page) |
| `DELETE /api/history/{run_id}` | delete a run; its camera is dropped when it has no runs left |
| `POST /api/history/import` | bulk insert, body `{ "reports": [<report>, ...] }` (idempotent by `run_id`) |

Filtering precedence in the UI: a selected **camera** wins over a selected
**model**; with neither, all runs are returned.

---

## 5. Migration guidelines

### 5.1 Existing in-browser history → backend (automatic)

Older builds stored runs under `localStorage["onvif-console-history-v1"]`. On
first load after upgrading, the UI calls `migrateLocalHistory()` once:

1. reads the legacy entries,
2. `POST`s their reports to `/api/history/import`,
3. marks migration done (`onvif-console-history-migrated`) and removes the old
   `localStorage` key.

It is idempotent (import de-dupes by `run_id`) and self-clears — no user action
needed. If the backend is unreachable at that moment, it silently retries on a
later load.

**Force a re-run** (e.g. testing): in the browser console,
`localStorage.removeItem('onvif-console-history-migrated')` then reload.

### 5.2 Upgrading a running deployment

The DB schema is created automatically on first start (`CREATE TABLE IF NOT
EXISTS`), so no manual migration step is required.

- **Docker Compose:** pull/rebuild and `docker compose up -d --build`. Ensure the
  `./data` bind mount (or a named volume) is present *before* first run so the DB
  persists — see §6.
- **Bare metal / `start.sh`:** just restart. The DB appears at
  `backend/data/onvif_console.db`.

No destructive migrations ship in this change; upgrading only adds tables.

### 5.3 Importing runs from elsewhere / seeding

Anything shaped like a report can be posted to `/api/history/import` — useful for
seeding a new server from JSON exports or another instance:

```bash
curl -X POST http://<host>:5800/api/history/import \
  -H 'Content-Type: application/json' \
  -d '{"reports": [ <report-json>, ... ]}'
```

Each report needs at least `id`, `summary`, `results`, and `connection.device`
(manufacturer/model/serial) for correct grouping.

---

## 6. Deployment & infrastructure

### 6.1 Where the DB lives

| Deployment | Path | Notes |
|------------|------|-------|
| `start.sh` / bare metal | `backend/data/onvif_console.db` | gitignored |
| Docker Compose | container `/app/backend/data/` → host `./data` (bind mount) | survives `up --build` |
| Any | `$ONVIF_DB_PATH` if set | overrides the default path |

### 6.2 Docker volume

`docker-compose.yml` bind-mounts the DB directory:

```yaml
services:
  console:
    volumes:
      - ./data:/app/backend/data      # persists across rebuilds; easy to back up
```

Prefer Docker-managed storage? Replace with a named volume:

```yaml
    volumes:
      - onvif-data:/app/backend/data
volumes:
  onvif-data:
```

> **Removing the bind-mount directory / named volume deletes all history.**

### 6.3 Environment variables (history-related)

| Variable | Default | Effect |
|----------|---------|--------|
| `ONVIF_DB_PATH` | `backend/data/onvif_console.db` | absolute path to the SQLite file (point at a mounted volume) |

(Existing vars `GO2RTC_API`, `GO2RTC_PUBLIC_URL` are unchanged.)

### 6.4 Backups

- **Cold:** stop the server, copy the `.db` file (and `-wal`/`-shm` if present).
- **Hot:** `sqlite3 onvif_console.db ".backup /backup/onvif-$(date +%F).db"`.
- The DB is plain SQLite — inspect or export anytime with the `sqlite3` CLI.

### 6.5 Security

Unchanged from before, and still important: the console has **no
authentication** and relays camera credentials. The history DB stores device
metadata and full reports (host, model, serial, ONVIF call log) — **not**
passwords. Keep port 5800 on the LAN; do not expose it to the public internet.

---

## 7. Rollback

The change is additive (new tables + endpoints). To roll back to the previous
build, redeploy the older image/commit; the SQLite file is simply ignored by
older code. No schema downgrade is needed, and the file can be kept for a later
re-upgrade or deleted to reclaim space.

---

## 8. Verification checklist

- [ ] `GET /api/session` returns 404 before connecting (server up).
- [ ] Run tests, then `GET /api/history` shows the run; `GET
      /api/history/cameras` lists the camera with `run_count`.
- [ ] Open `/history` — filter chips (model/camera) and, for a filtered set with
      ≥2 runs, the trend matrix render.
- [ ] Open a run from history → report page loads by `run_id`.
- [ ] Restart the server / rebuild the container → history is still present
      (volume/DB persisted).
