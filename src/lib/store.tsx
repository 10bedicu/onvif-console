"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
} from "react";
import { api, eventsUrl } from "./api";
import { saveRun } from "./history";
import type {
  CallEvent,
  Connection,
  EngineEvent,
  Report,
  StatusEvent,
  StreamInfo,
  TestMeta,
  TestResult,
  TestStatus,
} from "./types";

type State = {
  phase: "idle" | "connecting" | "connected" | "error";
  connectionError: string | null;
  connection: Connection | null;
  stream: StreamInfo | null;
  tests: TestMeta[];
  results: Record<string, TestResult>;
  progress: Record<string, number>;
  liveLogs: Record<string, { ts: number; level: string; msg: string }[]>;
  calls: CallEvent[];
  status: StatusEvent | null;
  running: boolean;
  runId: string | null;
  lastReport: Report | null;
};

const initial: State = {
  phase: "idle",
  connectionError: null,
  connection: null,
  stream: null,
  tests: [],
  results: {},
  progress: {},
  liveLogs: {},
  calls: [],
  status: null,
  running: false,
  runId: null,
  lastReport: null,
};

type Action =
  | { type: "connecting" }
  | {
      type: "connected";
      connection: Connection;
      stream: StreamInfo;
      tests: TestMeta[];
      results?: Record<string, TestResult>;
      calls?: CallEvent[];
      running?: boolean;
    }
  | { type: "connect-error"; error: string }
  | { type: "disconnected" }
  | { type: "event"; event: EngineEvent }
  | { type: "report"; report: Report };

function emptyResult(id: string): TestResult {
  return {
    id,
    status: "pending",
    checks: [],
    logs: [],
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    detail: "",
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "connecting":
      return { ...initial, phase: "connecting" };
    case "connected": {
      const results: Record<string, TestResult> = {};
      for (const t of action.tests) {
        results[t.id] = action.results?.[t.id] ?? emptyResult(t.id);
      }
      return {
        ...state,
        phase: "connected",
        connectionError: null,
        connection: action.connection,
        stream: action.stream,
        tests: action.tests,
        results,
        calls: action.calls ?? [],
        running: action.running ?? false,
      };
    }
    case "connect-error":
      return { ...initial, phase: "error", connectionError: action.error };
    case "disconnected":
      return { ...initial };
    case "event":
      return applyEvent(state, action.event);
    case "report":
      return { ...state, lastReport: action.report };
    default:
      return state;
  }
}

function applyEvent(state: State, e: EngineEvent): State {
  switch (e.type) {
    case "status":
      return { ...state, status: e };
    case "call": {
      const calls = [...state.calls, e].slice(-500);
      return { ...state, calls };
    }
    case "log": {
      const logs = [...(state.liveLogs[e.testId] ?? []), { ts: e.ts, level: e.level, msg: e.msg }];
      return { ...state, liveLogs: { ...state.liveLogs, [e.testId]: logs } };
    }
    case "test": {
      const prev = state.results[e.testId] ?? emptyResult(e.testId);
      const next: TestResult = e.result ?? { ...prev, status: e.status as TestStatus };
      const progress = { ...state.progress };
      if (typeof e.progress === "number") progress[e.testId] = e.progress;
      if (e.status !== "running") progress[e.testId] = 100;
      // (log resets happen on run start, not here — a wipe here would race
      // with the first log line of the test)
      return {
        ...state,
        results: { ...state.results, [e.testId]: next },
        progress,
      };
    }
    case "run":
      if (e.status === "started") {
        const results = { ...state.results };
        const progress = { ...state.progress };
        const liveLogs = { ...state.liveLogs };
        for (const id of e.testIds ?? []) {
          results[id] = emptyResult(id);
          progress[id] = 0;
          liveLogs[id] = [];
        }
        return { ...state, running: true, runId: e.runId, results, progress, liveLogs };
      }
      return { ...state, running: false };
    case "connection":
      if (!e.connected) return { ...initial };
      return state;
    default:
      return state;
  }
}

type Store = State & {
  connect: (host: string, port: number, username: string, password: string) => Promise<void>;
  disconnect: () => Promise<void>;
  runAll: () => Promise<void>;
  runOne: (id: string) => Promise<void>;
  cancel: () => Promise<void>;
  refreshReport: () => Promise<Report | null>;
};

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const esRef = useRef<EventSource | null>(null);
  const phaseRef = useRef(state.phase);
  phaseRef.current = state.phase;

  const openEvents = useCallback(() => {
    esRef.current?.close();
    const es = new EventSource(eventsUrl());
    es.onmessage = (m) => {
      try {
        dispatch({ type: "event", event: JSON.parse(m.data) });
      } catch {
        /* ignore malformed */
      }
    };
    esRef.current = es;
  }, []);

  // Try to restore an existing backend session on mount (page refresh).
  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const s = (await api.session()) as {
          connection: Connection;
          stream: StreamInfo;
          tests: TestMeta[];
          results: Record<string, TestResult>;
          calls: CallEvent[];
          running: boolean;
        };
        if (stale) return;
        dispatch({ type: "connected", ...s });
        openEvents();
      } catch {
        /* no session — stay idle */
      }
    })();
    return () => {
      stale = true;
      esRef.current?.close();
    };
  }, [openEvents]);

  const refreshReport = useCallback(async (): Promise<Report | null> => {
    try {
      const r = (await api.report()) as Report;
      dispatch({ type: "report", report: r });
      return r;
    } catch {
      return null;
    }
  }, []);

  // When a run finishes, fetch the full report and persist to history.
  const runningRef = useRef(state.running);
  useEffect(() => {
    if (runningRef.current && !state.running) {
      refreshReport().then((r) => {
        if (r && r.finishedAt) saveRun(r);
      });
    }
    runningRef.current = state.running;
  }, [state.running, refreshReport]);

  const connect = useCallback(
    async (host: string, port: number, username: string, password: string) => {
      dispatch({ type: "connecting" });
      try {
        const res = (await api.connect({ host, port, username, password })) as {
          connection: Connection;
          stream: StreamInfo;
          tests: TestMeta[];
        };
        dispatch({ type: "connected", ...res });
        openEvents();
      } catch (e) {
        dispatch({
          type: "connect-error",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [openEvents],
  );

  const disconnect = useCallback(async () => {
    esRef.current?.close();
    esRef.current = null;
    try {
      await api.disconnect();
    } finally {
      dispatch({ type: "disconnected" });
    }
  }, []);

  const runAll = useCallback(async () => {
    await api.runTests();
  }, []);
  const runOne = useCallback(async (id: string) => {
    await api.runTests([id]);
  }, []);
  const cancel = useCallback(async () => {
    await api.cancel();
  }, []);

  const store: Store = {
    ...state,
    connect,
    disconnect,
    runAll,
    runOne,
    cancel,
    refreshReport,
  };

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}
