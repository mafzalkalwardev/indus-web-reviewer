import fs from "fs";
import path from "path";
import { CategoryRule, DiscoveredSelectors, ReviewLogEntry, RunSummary } from "./types";
import { WorkerStateFile, WorkerStatus, WorkerTarget, defaultWorkerState } from "./workerTypes";
import { HUMANATIC_CATEGORIES } from "./categories";

const dataDir = path.resolve(process.cwd(), "data");
const categoryCachePath = path.join(dataDir, "categories.json");
const reviewLogPath = path.join(dataDir, "reviews.json");
const selectorsPath = path.join(dataDir, "selectors.json");
const runSummaryPath = path.join(dataDir, "run-summary.json");
const workerStatePath = path.join(dataDir, "worker-state.json");
const scrapedCategoriesPath = path.resolve(
  process.cwd(),
  "analysis-output",
  "categories",
  "ALL_CATEGORIES.json",
);

const ensureDataDir = (): void => {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
};

export const loadCategoryCache = (): CategoryRule[] => {
  ensureDataDir();
  if (!fs.existsSync(categoryCachePath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(categoryCachePath, "utf-8")) as CategoryRule[];
};

export const saveCategoryCache = (categories: CategoryRule[]): void => {
  ensureDataDir();
  fs.writeFileSync(categoryCachePath, JSON.stringify(categories, null, 2), "utf-8");
};

/** In-process cache — avoid re-parsing multi‑MB reviews.json on every append. */
let reviewLogCache: ReviewLogEntry[] | null = null;
const MAX_REVIEW_LOG_ENTRIES = 10_000;

export const loadReviewLog = (): ReviewLogEntry[] => {
  ensureDataDir();
  if (reviewLogCache) return reviewLogCache;
  if (!fs.existsSync(reviewLogPath)) {
    reviewLogCache = [];
    return reviewLogCache;
  }
  try {
    reviewLogCache = JSON.parse(fs.readFileSync(reviewLogPath, "utf-8")) as ReviewLogEntry[];
  } catch {
    reviewLogCache = [];
  }
  return reviewLogCache;
};

export const appendReviewLog = (entry: ReviewLogEntry): void => {
  ensureDataDir();
  const existing = loadReviewLog();
  existing.push(entry);
  if (existing.length > MAX_REVIEW_LOG_ENTRIES) {
    reviewLogCache = existing.slice(-MAX_REVIEW_LOG_ENTRIES);
  }
  // Compact JSON (no pretty-print) — much cheaper CPU/IO under load
  fs.writeFileSync(reviewLogPath, JSON.stringify(reviewLogCache || existing), "utf-8");
};

export const loadDiscoveredSelectors = (): Partial<DiscoveredSelectors> | null => {
  ensureDataDir();
  if (!fs.existsSync(selectorsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(selectorsPath, "utf-8")) as Partial<DiscoveredSelectors>;
  } catch {
    return null;
  }
};

export const saveDiscoveredSelectors = (selectors: DiscoveredSelectors): void => {
  ensureDataDir();
  fs.writeFileSync(selectorsPath, JSON.stringify(selectors, null, 2), "utf-8");
};

export const saveRunSummary = (summary: RunSummary): void => {
  ensureDataDir();
  fs.writeFileSync(runSummaryPath, JSON.stringify(summary, null, 2), "utf-8");
};

export const loadWorkerState = (): WorkerStateFile => {
  ensureDataDir();
  if (!fs.existsSync(workerStatePath)) {
    const initial = defaultWorkerState();
    fs.writeFileSync(workerStatePath, JSON.stringify(initial, null, 2), "utf-8");
    return initial;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(workerStatePath, "utf-8")) as WorkerStateFile;
    const base = defaultWorkerState();
    return {
      target: { ...base.target, ...raw.target },
      status: { ...base.status, ...raw.status },
    };
  } catch {
    return defaultWorkerState();
  }
};

export const saveWorkerState = (state: WorkerStateFile): void => {
  ensureDataDir();
  fs.writeFileSync(workerStatePath, JSON.stringify(state, null, 2), "utf-8");
};

export const patchWorkerTarget = (patch: Partial<WorkerTarget>): WorkerStateFile => {
  const state = loadWorkerState();
  state.target = { ...state.target, ...patch };
  if (patch.categoryId != null && !patch.categoryName) {
    const known = HUMANATIC_CATEGORIES.find((c) => c.id === patch.categoryId);
    if (known) state.target.categoryName = known.name;
  }
  saveWorkerState(state);
  return state;
};

let lastStatusDiskAt = 0;
let lastStatusDiskKey = "";

export const patchWorkerStatus = (patch: Partial<WorkerStatus>): WorkerStateFile => {
  const state = loadWorkerState();
  const nextMsg = patch.message ?? state.status.message;
  const nextState = patch.state ?? state.status.state;
  const now = Date.now();
  const progressLike = /Listening|waiting for options|Unlock|@\s*[\d.]+x/i.test(nextMsg || "");
  const stateChanged = nextState !== state.status.state;
  state.status = {
    ...state.status,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  // Progress spam — disk-write at most every 10s unless state flips
  if (progressLike && !stateChanged && now - lastStatusDiskAt < 10_000) {
    return state;
  }
  saveWorkerState(state);
  lastStatusDiskAt = now;
  lastStatusDiskKey = `${nextState}|${nextMsg}`;
  return state;
};

export type DashboardCategory = {
  id: number;
  name: string;
  key: string;
  payoutCents: number | null;
  payoutLabel: string;
  lastStatus: string;
  availableCalls: string;
  instructionsChars: number;
};

const parsePayoutCents = (raw: string | undefined): number | null => {
  if (!raw) return null;
  const m = String(raw).replace(/,/g, "").match(/([\d.]+)\s*¢/);
  return m ? Number(m[1]) : null;
};

export const loadDashboardCategories = (): DashboardCategory[] => {
  type Scraped = {
    categoryId?: number | null;
    name?: string;
    payout?: string;
    status?: string;
    availableCalls?: string;
    instructions?: string;
  };

  let scraped: Scraped[] = [];
  if (fs.existsSync(scrapedCategoriesPath)) {
    try {
      scraped = JSON.parse(fs.readFileSync(scrapedCategoriesPath, "utf-8")) as Scraped[];
    } catch {
      scraped = [];
    }
  }

  const byId = new Map<number, DashboardCategory>();

  for (const c of HUMANATIC_CATEGORIES) {
    byId.set(c.id, {
      id: c.id,
      name: c.name,
      key: c.key,
      payoutCents: null,
      payoutLabel: "",
      lastStatus: "unknown",
      availableCalls: "",
      instructionsChars: 0,
    });
  }

  for (const row of scraped) {
    if (row.categoryId == null) continue;
    const prev = byId.get(row.categoryId);
    const payoutLabel = row.payout || prev?.payoutLabel || "";
    byId.set(row.categoryId, {
      id: row.categoryId,
      name: row.name || prev?.name || `Category ${row.categoryId}`,
      key: prev?.key || `cat_${row.categoryId}`,
      payoutCents: parsePayoutCents(payoutLabel),
      payoutLabel,
      lastStatus: row.status || prev?.lastStatus || "unknown",
      availableCalls: row.availableCalls || "",
      instructionsChars: (row.instructions || "").length,
    });
  }

  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
};

export type DashboardStats = {
  reviewsTotal: number;
  submitted: number;
  practiceSelected: number;
  skipped: number;
  accuracyProxy: number;
  estimatedEarningsCents: number;
  estimatedEarningsLabel: string;
  byCategory: Array<{ categoryId: string; submitted: number; avgConfidence: number }>;
};

/** Avoid re-walking the full review log on every dashboard poll. */
const reviewLogMtime = (): number => {
  try {
    return fs.existsSync(reviewLogPath) ? fs.statSync(reviewLogPath).mtimeMs : 0;
  } catch {
    return 0;
  }
};

let statsCache: { mtime: number; value: DashboardStats } | null = null;

export const computeDashboardStats = (): DashboardStats => {
  const mtime = reviewLogMtime();
  if (statsCache && statsCache.mtime === mtime) return statsCache.value;

  const reviews = loadReviewLog();
  const categories = loadDashboardCategories();
  const payoutById = new Map(categories.map((c) => [String(c.id), c.payoutCents || 0]));

  let submitted = 0;
  let practiceSelected = 0;
  let skipped = 0;
  let confidenceSum = 0;
  let confidenceN = 0;
  let estimatedEarningsCents = 0;
  const byCat = new Map<string, { submitted: number; confSum: number; confN: number }>();

  for (const r of reviews) {
    if (r.status === "submitted") {
      submitted += 1;
      estimatedEarningsCents += payoutById.get(r.category_id) || 0;
      confidenceSum += r.confidence || 0;
      confidenceN += 1;
      const slot = byCat.get(r.category_id) || { submitted: 0, confSum: 0, confN: 0 };
      slot.submitted += 1;
      slot.confSum += r.confidence || 0;
      slot.confN += 1;
      byCat.set(r.category_id, slot);
    } else if (r.status === "practice_selected") {
      practiceSelected += 1;
      confidenceSum += r.confidence || 0;
      confidenceN += 1;
    } else if (r.status.startsWith("skipped")) {
      skipped += 1;
    }
  }

  const decided = submitted + practiceSelected + skipped;
  const accuracyProxy =
    decided > 0
      ? (submitted + practiceSelected) / decided
      : confidenceN > 0
        ? confidenceSum / confidenceN
        : 0;

  const value: DashboardStats = {
    reviewsTotal: reviews.length,
    submitted,
    practiceSelected,
    skipped,
    accuracyProxy: Number(accuracyProxy.toFixed(3)),
    estimatedEarningsCents: Number(estimatedEarningsCents.toFixed(3)),
    estimatedEarningsLabel: `${estimatedEarningsCents.toFixed(2)}¢`,
    byCategory: Array.from(byCat.entries()).map(([categoryId, v]) => ({
      categoryId,
      submitted: v.submitted,
      avgConfidence: v.confN ? Number((v.confSum / v.confN).toFixed(3)) : 0,
    })),
  };
  statsCache = { mtime, value };
  return value;
};

/* ─── Realtime activity feed + daily reports ─── */

const activityPath = path.join(dataDir, "activity.json");

export type ActivityEvent = {
  at: string;
  state: string;
  message: string;
  url?: string;
  sceneKind?: string;
  sceneAction?: string;
};

let activityWriteQuietUntil = 0;

export const appendActivityEvent = (event: ActivityEvent, opts?: { force?: boolean }): void => {
  ensureDataDir();
  const progressLike = /Listening|waiting for options|Unlock|@\s*[\d.]+x|Next queue try/i.test(
    event.message || "",
  );
  // Drop high-frequency progress noise from activity feed (keeps RAM/CPU down)
  if (progressLike && !opts?.force) {
    if (Date.now() < activityWriteQuietUntil) return;
    activityWriteQuietUntil = Date.now() + 20_000;
  }

  let list: ActivityEvent[] = [];
  try {
    if (fs.existsSync(activityPath)) {
      list = JSON.parse(fs.readFileSync(activityPath, "utf8")) as ActivityEvent[];
    }
  } catch {
    list = [];
  }
  const prev = list[list.length - 1];
  // Dedupe identical status spam (same message within 12s)
  if (
    prev &&
    prev.message === event.message &&
    prev.state === event.state &&
    Date.parse(event.at) - Date.parse(prev.at) < 12_000
  ) {
    list[list.length - 1] = event;
  } else {
    list.push(event);
  }
  if (list.length > 400) list = list.slice(-400);
  fs.writeFileSync(activityPath, JSON.stringify(list), "utf8");
};

export const loadActivityFeed = (limit = 80): ActivityEvent[] => {
  ensureDataDir();
  try {
    if (!fs.existsSync(activityPath)) return [];
    const list = JSON.parse(fs.readFileSync(activityPath, "utf8")) as ActivityEvent[];
    return list.slice(-Math.max(1, Math.min(limit, 400))).reverse();
  } catch {
    return [];
  }
};

/** Calendar day in America/Los_Angeles as YYYY-MM-DD */
export const calendarDayLA = (iso: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return (iso || "").slice(0, 10);
  }
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

const summarizeDay = (day: string, label: string, reviews: ReviewLogEntry[]): DailyReport => {
  const categories = loadDashboardCategories();
  const payoutById = new Map(categories.map((c) => [String(c.id), c.payoutCents || 0]));
  const rows = reviews.filter((r) => calendarDayLA(r.timestamp) === day);

  let submitted = 0;
  let skipped = 0;
  let practiceSelected = 0;
  let skippedNoTranscript = 0;
  let skippedLowConfidence = 0;
  let skippedHeuristic = 0;
  let skippedError = 0;
  let estimatedEarningsCents = 0;
  let confSum = 0;
  let confN = 0;
  const reasonMap = new Map<string, number>();
  const hourMap = new Map<string, { submitted: number; skipped: number }>();

  for (const r of rows) {
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      hour12: false,
    }).format(new Date(r.timestamp));
    const slot = hourMap.get(hour) || { submitted: 0, skipped: 0 };

    if (r.status === "submitted") {
      submitted += 1;
      estimatedEarningsCents += payoutById.get(String(r.category_id)) || 0;
      confSum += r.confidence || 0;
      confN += 1;
      slot.submitted += 1;
    } else if (r.status === "practice_selected") {
      practiceSelected += 1;
    } else if (String(r.status).startsWith("skipped")) {
      skipped += 1;
      slot.skipped += 1;
      if (r.status === "skipped_no_transcript") skippedNoTranscript += 1;
      else if (r.status === "skipped_low_confidence") skippedLowConfidence += 1;
      else if (r.status === "skipped_heuristic_blocked") skippedHeuristic += 1;
      else skippedError += 1;
      const reason = (r.reasoning || r.status).replace(/\s+/g, " ").slice(0, 90);
      reasonMap.set(reason, (reasonMap.get(reason) || 0) + 1);
    }
    hourMap.set(hour, slot);
  }

  const firstAt = rows[0]?.timestamp || null;
  const lastAt = rows.length ? rows[rows.length - 1].timestamp : null;
  const activeSpanHours =
    firstAt && lastAt ? Number(((Date.parse(lastAt) - Date.parse(firstAt)) / 3600000).toFixed(2)) : 0;

  return {
    day,
    label,
    submitted,
    skipped,
    practiceSelected,
    skippedNoTranscript,
    skippedLowConfidence,
    skippedHeuristic,
    skippedError,
    estimatedEarningsCents: Number(estimatedEarningsCents.toFixed(3)),
    estimatedEarningsLabel: `$${(estimatedEarningsCents / 100).toFixed(2)}`,
    avgConfidence: confN ? Number((confSum / confN).toFixed(3)) : 0,
    firstAt,
    lastAt,
    activeSpanHours,
    topSkipReasons: Array.from(reasonMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count })),
    byHour: Array.from(hourMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([hour, v]) => ({ hour: `${hour}:00`, ...v })),
  };
};

let dailyCache: { mtime: number; value: { today: DailyReport; yesterday: DailyReport } } | null =
  null;

export const computeDailyReports = (): { today: DailyReport; yesterday: DailyReport } => {
  const mtime = reviewLogMtime();
  if (dailyCache && dailyCache.mtime === mtime) return dailyCache.value;

  const reviews = loadReviewLog().slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const now = new Date();
  const today = calendarDayLA(now.toISOString());
  const yDate = new Date(now.getTime() - 24 * 3600_000);
  const yesterday = calendarDayLA(yDate.toISOString());
  const value = {
    today: summarizeDay(today, "Today", reviews),
    yesterday: summarizeDay(yesterday, "Yesterday", reviews),
  };
  dailyCache = { mtime, value };
  return value;
};

export const computeDailyReportFor = (dayOrAlias: string): DailyReport => {
  const reviews = loadReviewLog().slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const now = new Date();
  if (dayOrAlias === "today" || !dayOrAlias) {
    return summarizeDay(calendarDayLA(now.toISOString()), "Today", reviews);
  }
  if (dayOrAlias === "yesterday") {
    return summarizeDay(
      calendarDayLA(new Date(now.getTime() - 24 * 3600_000).toISOString()),
      "Yesterday",
      reviews,
    );
  }
  return summarizeDay(dayOrAlias, dayOrAlias, reviews);
};
