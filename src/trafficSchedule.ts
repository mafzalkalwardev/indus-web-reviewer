/**
 * Humanatic traffic windows (EST) + local learning from queue hits/misses.
 *
 * Research (Humanatic FAQ + reviewer guides):
 * - Largest volume: 7:00 AM – 7:00 PM US Eastern
 * - Busiest often cited: ~8 AM – 8 PM EST, Mon–Sat
 * - Prime Time bonus (when active): weekdays 4:00–6:59 PM EST (+10%)
 * - Off-peak nights: sparse inventory; longer waits expected
 *
 * Category heuristics (business-hour US call centers / dealerships / outbound dialers):
 * - Morning: Inbound, Department (customers calling businesses)
 * - Midday–afternoon: Live outbound, Dealership, Home Services
 * - Prime afternoon: highest payout first
 * - Evening taper: Inbound leftovers, Rent Buzz
 * - Overnight: slow cycle, prefer not to spam
 */
import fs from "fs";
import path from "path";
import { HUMANATIC_CATEGORIES } from "./categories";
import { loadDashboardCategories } from "./storage";

const DATA_DIR = path.resolve(process.cwd(), "data");
const OBS_PATH = path.join(DATA_DIR, "traffic-observations.json");

export type TrafficWindow =
  | "overnight"
  | "early_morning"
  | "morning"
  | "midday"
  | "afternoon"
  | "prime"
  | "evening";

export type QueueOutcome = "hit" | "empty" | "missing" | "login_bounce";

type Observation = {
  ts: string;
  categoryId: number;
  outcome: QueueOutcome;
  hourEst: number;
  weekdayEst: number; // 0=Sun
  window: TrafficWindow;
};

type ObservationFile = { observations: Observation[] };

/** Prefer order within each EST window (first = try first). */
const WINDOW_PREFERENCE: Record<TrafficWindow, number[]> = {
  // Quiet — long cool-downs; stick to baseline inbound
  overnight: [3, 87, 4, 78, 223, 20],
  // Early shoppers / service openers
  early_morning: [3, 87, 223, 4, 20, 78],
  // Peak business inbound + dept routing
  morning: [3, 87, 4, 223, 20, 78],
  // Outbound dialer + dealership / home services volume
  midday: [4, 20, 223, 3, 87, 78],
  afternoon: [4, 223, 20, 87, 3, 78],
  // Prime Time bonus window — payout-first among available
  prime: [20, 223, 4, 87, 3, 78],
  evening: [3, 4, 78, 87, 223, 20],
};

export type EstClock = {
  hour: number;
  minute: number;
  weekday: number;
  isoDay: string;
  label: string;
};

/** Current time in US Eastern (handles EST/EDT). */
export const getEstClock = (now = new Date()): EstClock => {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour === "24" ? "0" : parts.hour);
  const minute = Number(parts.minute);
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdayMap[parts.weekday] ?? now.getDay();
  return {
    hour,
    minute,
    weekday,
    isoDay: `${parts.year}-${parts.month}-${parts.day}`,
    label: `${parts.weekday} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ET`,
  };
};

export const classifyTrafficWindow = (hour: number, weekday: number): TrafficWindow => {
  // Sun overnight-like slower mornings
  if (hour >= 22 || hour < 6) return "overnight";
  if (hour >= 6 && hour < 8) return "early_morning";
  if (hour >= 8 && hour < 11) return "morning";
  if (hour >= 11 && hour < 14) return "midday";
  if (hour >= 14 && hour < 16) return "afternoon";
  // Official prime bonus band weekdays 16:00–18:59
  if (hour >= 16 && hour < 19 && weekday >= 1 && weekday <= 5) return "prime";
  if (hour >= 16 && hour < 19) return "afternoon";
  if (hour >= 19 && hour < 22) return "evening";
  return "overnight";
};

export const isPeakVolumeHours = (hour: number): boolean => hour >= 7 && hour < 19;

export const isPrimeBonusWindow = (hour: number, weekday: number): boolean =>
  weekday >= 1 && weekday <= 5 && hour >= 16 && hour < 19;

/** Suggested empty-queue cooldown by window (ms). */
export const cooldownForWindow = (window: TrafficWindow): number => {
  switch (window) {
    case "overnight":
      return 90000;
    case "early_morning":
      return 50000;
    case "evening":
      return 55000;
    case "prime":
      return 28000;
    default:
      return 40000;
  }
};

const loadObservations = (): Observation[] => {
  try {
    if (!fs.existsSync(OBS_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(OBS_PATH, "utf-8")) as ObservationFile;
    return Array.isArray(raw.observations) ? raw.observations : [];
  } catch {
    return [];
  }
};

const saveObservations = (observations: Observation[]) => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // Cap file size
  const trimmed = observations.slice(-2000);
  fs.writeFileSync(OBS_PATH, JSON.stringify({ observations: trimmed }, null, 2), "utf-8");
};

export const recordQueueOutcome = (categoryId: number, outcome: QueueOutcome): void => {
  const clock = getEstClock();
  const window = classifyTrafficWindow(clock.hour, clock.weekday);
  const observations = loadObservations();
  observations.push({
    ts: new Date().toISOString(),
    categoryId,
    outcome,
    hourEst: clock.hour,
    weekdayEst: clock.weekday,
    window,
  });
  saveObservations(observations);
};

type CategoryScore = {
  categoryId: number;
  name: string;
  score: number;
  hits: number;
  empties: number;
  payoutCents: number;
  reason: string;
};

const localScoreForHour = (
  categoryId: number,
  hour: number,
  observations: Observation[],
): { hits: number; empties: number; rate: number } => {
  // Weight recent same-hour observations more
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  let hits = 0;
  let empties = 0;
  for (const o of observations) {
    if (o.categoryId !== categoryId) continue;
    if (Date.parse(o.ts) < cutoff) continue;
    // Same hour ±1
    if (Math.abs(o.hourEst - hour) > 1 && !(hour === 0 && o.hourEst === 23)) continue;
    if (o.outcome === "hit") hits += 1;
    if (o.outcome === "empty" || o.outcome === "missing") empties += 1;
  }
  const total = hits + empties;
  const rate = total === 0 ? 0.35 : hits / total; // prior when unknown
  return { hits, empties, rate };
};

export const rankCategoriesForNow = (): {
  clock: EstClock;
  window: TrafficWindow;
  peak: boolean;
  primeBonus: boolean;
  ranked: CategoryScore[];
  tip: string;
} => {
  const clock = getEstClock();
  const window = classifyTrafficWindow(clock.hour, clock.weekday);
  const peak = isPeakVolumeHours(clock.hour);
  const primeBonus = isPrimeBonusWindow(clock.hour, clock.weekday);
  const prefer = WINDOW_PREFERENCE[window];
  const observations = loadObservations();
  const dash = loadDashboardCategories();
  const payout = new Map(dash.map((c) => [c.id, c.payoutCents || 0]));
  const nameById = new Map(
    HUMANATIC_CATEGORIES.map((c) => [c.id, c.name] as const).concat(
      dash.map((c) => [c.id, c.name] as const),
    ),
  );

  const ranked: CategoryScore[] = prefer.map((id, idx) => {
    const local = localScoreForHour(id, clock.hour, observations);
    const pay = payout.get(id) || 0;
    // Base: preference rank + local hit rate + payout nudge in prime
    const prefScore = (prefer.length - idx) / prefer.length;
    const payoutNudge = primeBonus ? Math.min(0.35, pay / 10) : Math.min(0.2, pay / 15);
    const score = prefScore * 0.45 + local.rate * 0.4 + payoutNudge * 0.15;
    return {
      categoryId: id,
      name: nameById.get(id) || `Category ${id}`,
      score: Number(score.toFixed(3)),
      hits: local.hits,
      empties: local.empties,
      payoutCents: pay,
      reason:
        local.hits + local.empties === 0
          ? `heuristic for ${window}`
          : `${local.hits} hits / ${local.empties} empty @~${clock.hour}h ET`,
    };
  });

  ranked.sort((a, b) => b.score - a.score);

  let tip = peak
    ? "Peak volume window (7am–7pm ET) — keep cycling categories."
    : "Off-peak — expect more noCalls; longer waits are normal.";
  if (primeBonus) tip = "Prime Time (4–7pm ET weekdays) — prioritize higher-payout categories (+10% when Humanatic enables bonus).";
  if (window === "overnight") tip = "Overnight ET — inventory is usually thin; slow refresh to protect session.";

  return { clock, window, peak, primeBonus, ranked, tip };
};

/** Next category to try after an empty/miss (round-robin through ranked list). */
export const pickNextCategory = (
  currentId: number | null,
  excludeIds: number[] = [],
): { categoryId: number; categoryName: string; window: TrafficWindow; tip: string } | null => {
  const { ranked, window, tip } = rankCategoriesForNow();
  if (!ranked.length) return null;
  const excluded = new Set(excludeIds);
  const startIdx = currentId == null ? -1 : ranked.findIndex((r) => r.categoryId === currentId);
  for (let i = 1; i <= ranked.length; i++) {
    const cand = ranked[(startIdx + i + ranked.length) % ranked.length];
    if (!cand || excluded.has(cand.categoryId)) continue;
    return {
      categoryId: cand.categoryId,
      categoryName: cand.name,
      window,
      tip,
    };
  }
  const first = ranked[0];
  return {
    categoryId: first.categoryId,
    categoryName: first.name,
    window,
    tip,
  };
};

export const getTrafficInsightPayload = () => {
  const rankedNow = rankCategoriesForNow();
  const observations = loadObservations().slice(-50).reverse();
  return {
    ...rankedNow,
    cooldownMs: cooldownForWindow(rankedNow.window),
    research: {
      peakHoursEt: "7:00 AM – 7:00 PM",
      primeBonusEt: "Weekdays 4:00 – 6:59 PM (+10% when active)",
      source: "Humanatic FAQ + reviewer guides; refined by local queue observations",
    },
    recentObservations: observations,
  };
};
