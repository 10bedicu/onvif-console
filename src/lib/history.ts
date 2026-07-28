// Run history now lives in the backend store (see backend/store.py).
// This module only handles the one-time migration of runs that older builds
// saved in the browser's localStorage.
import type { Report } from "./types";
import { api } from "./api";

const KEY = "onvif-console-history-v1";
const MIGRATED_KEY = "onvif-console-history-migrated";

type LegacyEntry = { runId: string; report: Report };

function readLegacy(): Report[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as LegacyEntry[];
    return raw.map((e) => e.report).filter((r): r is Report => !!r?.id);
  } catch {
    return [];
  }
}

/**
 * Push any runs saved in localStorage by older builds into the backend store,
 * exactly once. Safe to call on every load — it no-ops after the first success.
 * Returns the number of runs imported (0 if none / already done).
 */
export async function migrateLocalHistory(): Promise<number> {
  if (typeof window === "undefined") return 0;
  if (localStorage.getItem(MIGRATED_KEY)) return 0;
  const reports = readLegacy();
  if (reports.length === 0) {
    localStorage.setItem(MIGRATED_KEY, String(Date.now()));
    return 0;
  }
  try {
    const { imported } = await api.importHistory(reports);
    localStorage.setItem(MIGRATED_KEY, String(Date.now()));
    localStorage.removeItem(KEY);
    return imported;
  } catch {
    return 0; // leave it for a later retry
  }
}
