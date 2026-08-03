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

export const loadReviewLog = (): ReviewLogEntry[] => {
  ensureDataDir();
  if (!fs.existsSync(reviewLogPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(reviewLogPath, "utf-8")) as ReviewLogEntry[];
  } catch {
    return [];
  }
};

export const appendReviewLog = (entry: ReviewLogEntry): void => {
  ensureDataDir();
  const existing = loadReviewLog();
  existing.push(entry);
  fs.writeFileSync(reviewLogPath, JSON.stringify(existing, null, 2), "utf-8");
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

export const patchWorkerStatus = (patch: Partial<WorkerStatus>): WorkerStateFile => {
  const state = loadWorkerState();
  state.status = {
    ...state.status,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  saveWorkerState(state);
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

export const computeDashboardStats = (): DashboardStats => {
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

  return {
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
};
