/**
 * Growth catalog — remember every Category List row (incl. newly unlocked),
 * track payouts, and pick highest-¢ categories that currently have stock.
 * Accuracy stays enforced elsewhere (confidence + no heuristic submit).
 */
import fs from "fs";
import path from "path";
import { HUMANATIC_CATEGORIES, CATEGORY_ID_REFERENCE, findCategoryById, KNOWN_PAYOUT_CENTS } from "./categories";

const dataDir = path.resolve(process.cwd(), "data");
const catalogPath = path.join(dataDir, "growth-catalog.json");

export type GrowthCategory = {
  categoryId: number;
  name: string;
  payoutCents: number;
  payoutLabel: string;
  lastAvailable: number;
  lastStatus: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** True when we first saw REVIEW / stock on this cat (unlock signal). */
  everHadStock: boolean;
  submits?: number;
};

type CatalogFile = {
  updatedAt: string;
  categories: GrowthCategory[];
};

let mem: CatalogFile | null = null;

const ensure = (): CatalogFile => {
  if (mem) return mem;
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(catalogPath)) {
    const seed: CatalogFile = {
      updatedAt: new Date().toISOString(),
      categories: HUMANATIC_CATEGORIES.map((c) => ({
        categoryId: c.id,
        name: c.name,
        payoutCents: KNOWN_PAYOUT_CENTS[c.id] || 0,
        payoutLabel: KNOWN_PAYOUT_CENTS[c.id] ? `${KNOWN_PAYOUT_CENTS[c.id]}¢` : "",
        lastAvailable: 0,
        lastStatus: "unknown",
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        everHadStock: false,
        submits: 0,
      })),
    };
    fs.writeFileSync(catalogPath, JSON.stringify(seed, null, 2), "utf8");
    mem = seed;
    return seed;
  }
  try {
    mem = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as CatalogFile;
  } catch {
    mem = { updatedAt: new Date().toISOString(), categories: [] };
  }
  return mem;
};

const save = (file: CatalogFile) => {
  file.updatedAt = new Date().toISOString();
  mem = file;
  fs.writeFileSync(catalogPath, JSON.stringify(file, null, 2), "utf8");
};

export const loadGrowthCatalog = (): GrowthCategory[] => ensure().categories.slice();

export const upsertGrowthRows = (
  rows: Array<{
    categoryId: number;
    name: string;
    available: number;
    availableLabel?: string;
    status?: string;
    payoutCents?: number;
    payoutLabel?: string;
  }>,
): { newlyUnlocked: GrowthCategory[] } => {
  const file = ensure();
  const byId = new Map(file.categories.map((c) => [c.categoryId, c]));
  const newlyUnlocked: GrowthCategory[] = [];
  const now = new Date().toISOString();

  for (const row of rows) {
    if (!row.categoryId || row.categoryId < 1) continue;
    const known =
      findCategoryById(row.categoryId) ||
      CATEGORY_ID_REFERENCE.find((c) => c.id === row.categoryId);
    const name = (row.name || known?.name || `Category ${row.categoryId}`).trim();
    const prev = byId.get(row.categoryId);
    const payoutCents =
      row.payoutCents != null && row.payoutCents > 0
        ? row.payoutCents
        : prev?.payoutCents || 0;
    const payoutLabel = row.payoutLabel || prev?.payoutLabel || "";
    const hadStock = (row.available || 0) > 0 || /review/i.test(row.status || "");
    if (!prev) {
      const created: GrowthCategory = {
        categoryId: row.categoryId,
        name,
        payoutCents,
        payoutLabel,
        lastAvailable: row.available || 0,
        lastStatus: row.status || "unknown",
        firstSeenAt: now,
        lastSeenAt: now,
        everHadStock: hadStock,
        submits: 0,
      };
      byId.set(row.categoryId, created);
      if (hadStock) newlyUnlocked.push(created);
      console.log(
        `[growth] Discovered #${row.categoryId} ${name} · ${payoutLabel || payoutCents + "¢"} · avail=${row.available}`,
      );
    } else {
      const wasLocked = !prev.everHadStock;
      prev.name = name || prev.name;
      if (payoutCents > 0) prev.payoutCents = payoutCents;
      if (payoutLabel) prev.payoutLabel = payoutLabel;
      prev.lastAvailable = row.available || 0;
      prev.lastStatus = row.status || prev.lastStatus;
      prev.lastSeenAt = now;
      if (hadStock) prev.everHadStock = true;
      if (wasLocked && hadStock) {
        newlyUnlocked.push(prev);
        console.log(
          `[growth] Newly unlocked stock on #${prev.categoryId} ${prev.name} (${prev.payoutLabel || prev.payoutCents + "¢"})`,
        );
      }
    }
  }

  file.categories = Array.from(byId.values()).sort(
    (a, b) => (b.payoutCents || 0) - (a.payoutCents || 0) || a.categoryId - b.categoryId,
  );
  save(file);
  return { newlyUnlocked };
};

export const noteGrowthSubmit = (categoryId: number) => {
  const file = ensure();
  const row = file.categories.find((c) => c.categoryId === categoryId);
  if (!row) return;
  row.submits = (row.submits || 0) + 1;
  save(file);
};

export type InventoryForGrowth = {
  categoryId: number;
  name: string;
  available: number;
  availableLabel: string;
  status: string;
  payoutCents: number;
  payoutLabel: string;
};

const resolveAccuracy = (name: string, byName?: Map<string, number>): number => {
  if (!byName || !byName.size) return 50; // neutral when unknown
  const key = name.toLowerCase().replace(/\s+/g, " ").trim();
  if (byName.has(key)) return byName.get(key)!;
  const first = key.split(/[:\-]/)[0]?.trim();
  if (first && byName.has(first)) return byName.get(first)!;
  for (const [k, v] of byName) {
    if (key.includes(k) || k.includes(first || key)) return v;
  }
  return 50;
};

/**
 * Expected ¢ keeping after audits — accuracy-first ranking for high money without LB death.
 * Unknown accuracy (~50) treated as moderate; near-zero accuracy heavily discounted.
 */
const expectedCents = (payoutCents: number, accuracyPct: number): number => {
  const pct = Math.max(0, Math.min(100, accuracyPct));
  // 0% site accuracy → 25% of payout weight; 100% → full weight
  const keep = 0.25 + 0.75 * (pct / 100);
  return (payoutCents || 0) * keep;
};

/**
 * Leaderboard + money pick (accuracy-first):
 * 1) Must have live stock
 * 2) Prefer cats you score well on (expected ¢ = payout × keep-rate)
 * 3) Skip near-zero accuracy cats when a healthier stocked cat exists
 * 4) Still lean high payout when accuracies are similar
 */
export const pickGrowthCategory = (
  inventory: InventoryForGrowth[],
  opts: {
    excludeIds?: number[];
    preferId?: number | null;
    accuracyByName?: Map<string, number>;
    accuracyFirst?: boolean;
  } = {},
): InventoryForGrowth | null => {
  const excluded = new Set(opts.excludeIds || []);
  const catalog = loadGrowthCatalog();
  const payById = new Map(catalog.map((c) => [c.categoryId, c.payoutCents || 0]));
  const accuracyFirst = opts.accuracyFirst !== false;

  let enriched = inventory
    .map((c) => {
      const payoutCents = c.payoutCents > 0 ? c.payoutCents : payById.get(c.categoryId) || 0;
      const accuracyPct = resolveAccuracy(c.name, opts.accuracyByName);
      return {
        ...c,
        payoutCents,
        accuracyPct,
        expectedCents: expectedCents(payoutCents, accuracyPct),
      };
    })
    .filter((c) => !excluded.has(c.categoryId))
    .filter((c) => c.available > 0 || /review/i.test(c.status));

  if (!enriched.length) return null;

  if (accuracyFirst) {
    const healthy = enriched.filter((c) => (c.accuracyPct || 0) >= 15);
    // Only drop toxic cats when a healthier alternative with stock exists
    if (healthy.length) enriched = healthy;
  }

  enriched.sort((a, b) => {
    if (accuracyFirst) {
      const expDiff = (b.expectedCents || 0) - (a.expectedCents || 0);
      if (Math.abs(expDiff) >= 0.12) return expDiff > 0 ? 1 : -1;
      const accDiff = (b.accuracyPct || 0) - (a.accuracyPct || 0);
      if (Math.abs(accDiff) >= 8) return accDiff > 0 ? 1 : -1;
      const payDiff = (b.payoutCents || 0) - (a.payoutCents || 0);
      if (Math.abs(payDiff) >= 0.25) return payDiff > 0 ? 1 : -1;
    } else {
      const payDiff = (b.payoutCents || 0) - (a.payoutCents || 0);
      if (Math.abs(payDiff) >= 0.3) return payDiff > 0 ? 1 : -1;
      const accDiff = (b.accuracyPct || 0) - (a.accuracyPct || 0);
      if (Math.abs(accDiff) >= 5) return accDiff > 0 ? 1 : -1;
    }
    if (opts.preferId != null) {
      if (a.categoryId === opts.preferId && b.categoryId !== opts.preferId) return -1;
      if (b.categoryId === opts.preferId && a.categoryId !== opts.preferId) return 1;
    }
    return b.available - a.available || a.categoryId - b.categoryId;
  });

  const best = enriched[0];
  console.log(
    `[growth] Pick #${best.categoryId} ${best.name} · ${best.payoutCents || "?"}¢ · acc~${best.accuracyPct}% · E≈${Number(best.expectedCents.toFixed(2))}¢ · stock=${best.availableLabel || best.available}`,
  );
  return best;
};

/** Monthly pace helper toward a dollar goal (default $100). */
export const growthPaceTip = (
  estimatedEarningsCentsToday: number,
  submitsToday: number,
  goalDollars = 100,
): string => {
  const dayOfMonth = new Date().getDate();
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const daysLeft = Math.max(1, daysInMonth - dayOfMonth + 1);
  const earnedSoFarDollars = estimatedEarningsCentsToday / 100; // today only tip
  const needPerDay = goalDollars / daysInMonth;
  const todayNeed = needPerDay;
  const pace =
    estimatedEarningsCentsToday / 100 >= todayNeed * 0.85
      ? "on pace"
      : estimatedEarningsCentsToday / 100 >= todayNeed * 0.5
        ? "behind"
        : "far behind";
  return `Growth ${pace} for ~$${goalDollars}/mo: today $${(estimatedEarningsCentsToday / 100).toFixed(2)} / ~$${todayNeed.toFixed(2)} needed · ${submitsToday} submits · ${daysLeft}d left in month`;
};
