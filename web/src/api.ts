declare global {
  interface Window {
    indusDesktop?: { isElectron?: boolean; apiBase?: string };
  }
}

const API =
  typeof window !== "undefined" && window.indusDesktop?.apiBase
    ? window.indusDesktop.apiBase
    : "";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const ms = Number((init as { timeoutMs?: number } | undefined)?.timeoutMs) || 12_000;
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      signal: ctrl.signal,
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
  } catch (e) {
    const name = (e as Error)?.name || "";
    const msg = (e as Error)?.message || String(e);
    if (name === "AbortError" || /aborted/i.test(msg)) {
      throw new Error("API slow — retrying…");
    }
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      throw new Error("Dashboard reconnecting…");
    }
    throw e instanceof Error ? e : new Error(msg);
  } finally {
    clearTimeout(timer);
  }
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
  autoRotate?: boolean;
  paused?: boolean;
  watchBrowser?: boolean;
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
  sceneKind?: string;
  sceneAction?: string;
  sceneSummary?: string;
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

export type TrafficInsight = {
  clock: { hour: number; minute: number; weekday: number; label: string };
  window: string;
  peak: boolean;
  primeBonus: boolean;
  tip: string;
  cooldownMs: number;
  ranked: Array<{
    categoryId: number;
    name: string;
    score: number;
    hits: number;
    empties: number;
    payoutCents: number;
    reason: string;
  }>;
  research: {
    peakHoursEt: string;
    primeBonusEt: string;
    source: string;
  };
};

export type DailyReport = {
  day: string;
  label: string;
  submitted: number;
  skipped: number;
  practiceSelected: number;
  skippedNoTranscript: number;
  skippedLowConfidence: number;
  skippedHeuristic: number;
  skippedError: number;
  estimatedEarningsCents: number;
  estimatedEarningsLabel: string;
  avgConfidence: number;
  firstAt: string | null;
  lastAt: string | null;
  activeSpanHours: number;
  topSkipReasons: Array<{ reason: string; count: number }>;
  byHour: Array<{ hour: string; submitted: number; skipped: number }>;
};

export type ActivityEvent = {
  at: string;
  state: string;
  message: string;
  url?: string;
  sceneKind?: string;
  sceneAction?: string;
};

export type HumanaticLive = {
  scrapedAt: string;
  profileName: string;
  todayEarningsLabel: string;
  todayEarningsCents: number | null;
  balanceLabel: string;
  balanceCents: number | null;
  periodLabel: string;
  accuracyOverallLabel: string;
  accuracyOverallPct: number | null;
  categoryAccuracy: Array<{ name: string; accuracyPct: number | null; raw: string }>;
  leaderboard: Array<{
    rank: number;
    name: string;
    scoreLabel: string;
    scoreCents: number | null;
    isYou: boolean;
  }>;
  yourRank: number | null;
  leaderboardTitle: string;
  goalDollars: number;
  goalProgressPct: number;
  goalTip: string;
};

export const api = {
  categories: () => json<Category[]>("/api/categories"),
  reviews: (limit = 50) => json<Review[]>(`/api/reviews?limit=${limit}`),
  stats: () => json<Stats>("/api/stats"),
  traffic: () => json<TrafficInsight>("/api/traffic"),
  status: () => json<WorkerStatus>("/api/worker/status"),
  target: () => json<WorkerTarget>("/api/worker/target"),
  setTarget: (body: Partial<WorkerTarget>) =>
    json<WorkerTarget>("/api/worker/target", { method: "POST", body: JSON.stringify(body) }),
  start: () => json<{ ok: boolean; pid?: number }>("/api/worker/start", { method: "POST" }),
  stop: () => json<{ ok: boolean }>("/api/worker/stop", { method: "POST" }),
  pause: () => json<{ ok: boolean; target: WorkerTarget }>("/api/worker/pause", { method: "POST" }),
  resume: () => json<{ ok: boolean; target: WorkerTarget }>("/api/worker/resume", { method: "POST" }),
  watch: (enabled: boolean) =>
    json<{ ok: boolean; target: WorkerTarget }>("/api/worker/watch", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  dailyReports: () =>
    json<{ today: DailyReport; yesterday: DailyReport }>("/api/reports/daily"),
  activity: (limit = 60) =>
    json<{ updatedAt: string; events: ActivityEvent[]; worker: WorkerStatus }>(
      `/api/activity?limit=${limit}`,
    ),
  growth: () =>
    json<{
      tip: string;
      todayEarningsCents: number;
      todaySubmitted: number;
      unlockedWithStock: number;
      localEstimateCents?: number;
      humanatic?: HumanaticLive;
      categories: Array<{
        categoryId: number;
        name: string;
        payoutCents: number;
        payoutLabel: string;
        everHadStock: boolean;
        lastAvailable: number;
      }>;
    }>("/api/growth"),
  humanaticLive: () => json<HumanaticLive>("/api/humanatic/live"),
};
