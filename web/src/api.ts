const API = ""; // proxied to :3847 in vite; absolute fallback for production preview

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export type Category = {
  id: number;
  name: string;
  key: string;
  payoutCents: number | null;
  payoutLabel: string;
  lastStatus: string;
  availableCalls: string;
  instructionsChars: number;
};

export type WorkerTarget = {
  categoryId: number | null;
  categoryName: string;
  enabled: boolean;
  practiceMode: boolean;
  refreshSeconds: number;
};

export type WorkerStatus = {
  state: string;
  currentUrl: string;
  lastCallAt: string | null;
  message: string;
  updatedAt: string;
  pid: number | null;
  workerProcessAlive?: boolean;
  target?: WorkerTarget;
};

export type Review = {
  call_id: string;
  timestamp: string;
  category_id: string;
  category_name?: string;
  selected_option_id: string;
  confidence: number;
  reasoning: string;
  latency_ms: number;
  status: string;
};

export type Stats = {
  reviewsTotal: number;
  submitted: number;
  practiceSelected: number;
  skipped: number;
  accuracyProxy: number;
  estimatedEarningsCents: number;
  estimatedEarningsLabel: string;
};

export const api = {
  categories: () => json<Category[]>("/api/categories"),
  reviews: (limit = 50) => json<Review[]>(`/api/reviews?limit=${limit}`),
  stats: () => json<Stats>("/api/stats"),
  status: () => json<WorkerStatus>("/api/worker/status"),
  target: () => json<WorkerTarget>("/api/worker/target"),
  setTarget: (body: Partial<WorkerTarget>) =>
    json<WorkerTarget>("/api/worker/target", { method: "POST", body: JSON.stringify(body) }),
  start: () => json<{ ok: boolean; pid?: number }>("/api/worker/start", { method: "POST" }),
  stop: () => json<{ ok: boolean }>("/api/worker/stop", { method: "POST" }),
};
