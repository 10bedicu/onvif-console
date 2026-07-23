// Multi-camera run history persisted in localStorage.
import type { Report } from "./types";

export type HistoryEntry = {
  runId: string;
  finishedAt: number;
  host: string;
  device: string;
  firmware: string;
  summary: Record<string, number>;
  report: Report;
};

const KEY = "onvif-console-history-v1";
const MAX_ENTRIES = 40;

export function loadHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveRun(report: Report) {
  const entry: HistoryEntry = {
    runId: report.id,
    finishedAt: report.finishedAt ?? Date.now() / 1000,
    host: report.connection?.host ?? "?",
    device: report.connection
      ? `${report.connection.device.manufacturer} ${report.connection.device.model}`
      : "?",
    firmware: report.connection?.device.firmware ?? "?",
    summary: report.summary,
    report,
  };
  const history = loadHistory().filter((h) => h.runId !== entry.runId);
  history.unshift(entry);
  localStorage.setItem(KEY, JSON.stringify(history.slice(0, MAX_ENTRIES)));
}

export function deleteRun(runId: string) {
  localStorage.setItem(
    KEY,
    JSON.stringify(loadHistory().filter((h) => h.runId !== runId)),
  );
}

export function getRun(runId: string): HistoryEntry | undefined {
  return loadHistory().find((h) => h.runId === runId);
}
