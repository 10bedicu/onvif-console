// The FastAPI sidecar serves the static UI in production (same origin).
// During `next dev` (port 3000) we target the sidecar on :5800 directly.
export const API_BASE =
  typeof window !== "undefined" && window.location.port === "3000"
    ? "http://localhost:5800"
    : "";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json();
}

export const api = {
  connect: (body: {
    host: string;
    port: number;
    username: string;
    password: string;
  }) => request<unknown>("/api/connect", { method: "POST", body: JSON.stringify(body) }),
  disconnect: () => request("/api/disconnect", { method: "POST" }),
  session: () => request<unknown>("/api/session"),
  runTests: (ids?: string[]) =>
    request("/api/tests/run", { method: "POST", body: JSON.stringify({ ids }) }),
  cancel: () => request("/api/tests/cancel", { method: "POST" }),
  report: () => request<unknown>("/api/report"),
  ptz: (action: string, params: Record<string, unknown> = {}) =>
    request("/api/ptz", { method: "POST", body: JSON.stringify({ action, params }) }),
  presets: () => request<{ presets: { token: string; name: string | null }[] }>("/api/presets"),
};

export const eventsUrl = () => `${API_BASE}/api/events`;
export const snapshotUrl = () => `${API_BASE}/api/snapshot`;
