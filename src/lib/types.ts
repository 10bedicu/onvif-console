export type Capabilities = {
  absolutePanTilt: boolean;
  relativePanTilt: boolean;
  continuousPanTilt: boolean;
  absoluteZoom: boolean;
  relativeZoom: boolean;
  continuousZoom: boolean;
  homeSupported: boolean;
  maxPresets: number;
  absPanTiltRange: [[number, number], [number, number]] | null;
  absZoomRange: [number, number] | null;
};

export type Connection = {
  host: string;
  port: number;
  user: string;
  device: {
    manufacturer: string;
    model: string;
    firmware: string;
    serial: string;
  };
  profiles: { token: string; name: string | null }[];
  hasPtz: boolean;
  capabilities: Capabilities;
  connectedAt: number;
};

export type StreamInfo = {
  webrtc: { available: boolean; embedUrl: string | null };
  snapshot: { available: boolean; endpoint: string };
  default: "webrtc" | "snapshot" | "none";
};

export type TestMeta = { id: string; name: string; description: string };

export type TestStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "error";

export type Check = { name: string; passed: boolean; detail: string };

export type Warning = { name: string; detail: string };

export type LogEntry = { ts: number; level: string; msg: string };

export type TestResult = {
  id: string;
  status: TestStatus;
  checks: Check[];
  warnings: Warning[];
  logs: LogEntry[];
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  detail: string;
};

export type CallEvent = {
  type: "call";
  id: string;
  op: string;
  params: string;
  durationMs: number;
  ok: boolean;
  error: string | null;
  kind: "poll" | "command";
  ts: number;
};

export type StatusEvent = {
  type: "status";
  position: { pan: number; tilt: number; zoom: number | null };
  moveStatus: { panTilt: string | null; zoom: string | null };
  ts: number;
};

export type EngineEvent =
  | CallEvent
  | StatusEvent
  | { type: "log"; testId: string; ts: number; level: string; msg: string }
  | {
      type: "test";
      testId: string;
      status: TestStatus;
      progress?: number | null;
      result?: TestResult;
      ts: number;
    }
  | {
      type: "run";
      status: "started" | "finished";
      runId: string;
      testIds?: string[];
      summary?: Record<string, number>;
      ts: number;
    }
  | { type: "connection"; connected: boolean; connection?: Connection; ts: number };

export type Report = {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  testIds: string[];
  connection: Connection;
  summary: Record<string, number>;
  results: TestResult[];
  tests: TestMeta[];
  calls: CallEvent[];
};

// Persisted-history shapes (from the backend store).
export type RunSummary = {
  run_id: string;
  camera_key: string;
  started_at: number;
  finished_at: number;
  duration_ms: number | null;
  passed: number;
  failed: number;
  skipped: number;
  error: number;
  total: number;
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  last_host: string | null;
  device: string;
};

export type CameraSummary = {
  camera_key: string;
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  last_firmware: string | null;
  last_host: string | null;
  last_seen: number | null;
  run_count: number;
  last_run: number | null;
};
