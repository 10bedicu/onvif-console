"""
SQLite-backed persistence for test-run history.

Single-file store (backend/data/onvif_console.db) using the stdlib sqlite3
module — no external dependency. A camera is identified by its ONVIF serial
number when present, falling back to host:port, so the same physical camera
keeps one history entry across IP changes.

The full report is kept as a JSON blob (`report_json`) for the report page;
the columns alongside it exist so history can be listed/filtered/grouped with
plain SQL (e.g. distinct models) without deserializing every run.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time

_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DEFAULT_DB = os.path.join(_DATA_DIR, "onvif_console.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS cameras (
    camera_key    TEXT PRIMARY KEY,
    manufacturer  TEXT,
    model         TEXT,
    serial        TEXT,
    last_firmware TEXT,
    last_host     TEXT,
    first_seen    REAL,
    last_seen     REAL
);
CREATE TABLE IF NOT EXISTS runs (
    run_id       TEXT PRIMARY KEY,
    camera_key   TEXT REFERENCES cameras(camera_key) ON DELETE CASCADE,
    started_at   REAL,
    finished_at  REAL,
    duration_ms  INTEGER,
    passed       INTEGER DEFAULT 0,
    failed       INTEGER DEFAULT 0,
    skipped      INTEGER DEFAULT 0,
    error        INTEGER DEFAULT 0,
    total        INTEGER DEFAULT 0,
    report_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_camera   ON runs(camera_key);
CREATE INDEX IF NOT EXISTS idx_runs_finished ON runs(finished_at);
"""


def camera_key_for(connection: dict | None) -> str:
    """Serial when the camera reports a non-trivial one, else host:port."""
    if not connection:
        return "unknown"
    device = connection.get("device") or {}
    serial = (device.get("serial") or "").strip()
    if serial and serial.lower() not in ("", "n/a", "unknown", "0", "00000000"):
        return f"serial:{serial}"
    host = connection.get("host") or "unknown"
    port = connection.get("port") or 80
    return f"host:{host}:{port}"


class HistoryStore:
    def __init__(self, path: str = DEFAULT_DB):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # check_same_thread=False: the run persists from a worker thread while
        # the API reads from the event-loop thread. A single lock serializes
        # all access, so one shared connection is safe.
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    # ---------- writes ----------
    def save_run(self, report: dict, connection: dict | None) -> str:
        """Persist a finished run and upsert its camera. Returns the run_id."""
        key = camera_key_for(connection)
        device = (connection or {}).get("device") or {}
        summary = report.get("summary") or {}
        now = time.time()
        started = report.get("startedAt")
        finished = report.get("finishedAt") or now
        duration = report.get("durationMs")
        if duration is None and started and finished:
            duration = round((finished - started) * 1000)

        with self._lock:
            self._conn.execute(
                """INSERT INTO cameras
                       (camera_key, manufacturer, model, serial,
                        last_firmware, last_host, first_seen, last_seen)
                   VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT(camera_key) DO UPDATE SET
                       manufacturer=excluded.manufacturer,
                       model=excluded.model,
                       serial=excluded.serial,
                       last_firmware=excluded.last_firmware,
                       last_host=excluded.last_host,
                       last_seen=excluded.last_seen""",
                (key, device.get("manufacturer"), device.get("model"),
                 device.get("serial"), device.get("firmware"),
                 (connection or {}).get("host"), now, now),
            )
            self._conn.execute(
                """INSERT INTO runs
                       (run_id, camera_key, started_at, finished_at, duration_ms,
                        passed, failed, skipped, error, total, report_json)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(run_id) DO UPDATE SET
                       finished_at=excluded.finished_at,
                       duration_ms=excluded.duration_ms,
                       passed=excluded.passed, failed=excluded.failed,
                       skipped=excluded.skipped, error=excluded.error,
                       total=excluded.total, report_json=excluded.report_json""",
                (report.get("id"), key, started, finished, duration,
                 summary.get("passed", 0), summary.get("failed", 0),
                 summary.get("skipped", 0), summary.get("error", 0),
                 # executed tests only (exclude tests left pending in a partial run)
                 sum(summary.get(k, 0) for k in
                     ("passed", "failed", "skipped", "error")),
                 json.dumps(report)),
            )
            self._conn.commit()
        return report.get("id")

    def delete_run(self, run_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM runs WHERE run_id=?", (run_id,))
            # drop the camera if it has no runs left
            self._conn.execute(
                """DELETE FROM cameras WHERE camera_key NOT IN
                   (SELECT DISTINCT camera_key FROM runs)""")
            self._conn.commit()
            return cur.rowcount > 0

    # ---------- reads ----------
    def list_runs(self, *, camera_key: str | None = None, model: str | None = None,
                  limit: int = 100, offset: int = 0) -> list[dict]:
        sql = ["""SELECT r.run_id, r.camera_key, r.started_at, r.finished_at,
                         r.duration_ms, r.passed, r.failed, r.skipped, r.error,
                         r.total, c.manufacturer, c.model, c.serial, c.last_host
                  FROM runs r JOIN cameras c ON c.camera_key = r.camera_key"""]
        where, params = [], []
        if camera_key:
            where.append("r.camera_key = ?")
            params.append(camera_key)
        if model:
            where.append("c.model = ?")
            params.append(model)
        if where:
            sql.append("WHERE " + " AND ".join(where))
        sql.append("ORDER BY r.finished_at DESC LIMIT ? OFFSET ?")
        params += [limit, offset]
        with self._lock:
            rows = self._conn.execute(" ".join(sql), params).fetchall()
        return [self._run_summary(r) for r in rows]

    def list_cameras(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                """SELECT c.camera_key, c.manufacturer, c.model, c.serial,
                          c.last_firmware, c.last_host, c.last_seen,
                          COUNT(r.run_id) AS run_count,
                          MAX(r.finished_at) AS last_run
                   FROM cameras c LEFT JOIN runs r ON r.camera_key = c.camera_key
                   GROUP BY c.camera_key
                   ORDER BY last_run DESC""").fetchall()
        return [dict(r) for r in rows]

    def get_run(self, run_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT report_json FROM runs WHERE run_id=?", (run_id,)).fetchone()
        return json.loads(row["report_json"]) if row else None

    def _run_summary(self, r: sqlite3.Row) -> dict:
        d = dict(r)
        d["device"] = f"{r['manufacturer'] or '?'} {r['model'] or '?'}".strip()
        return d
