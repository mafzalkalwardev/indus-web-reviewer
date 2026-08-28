/**
 * Wait-mode worker: Tampermonkey refreshes the selected category queue.
 * This process only watches Chrome (CDP) and reviews when a call screen appears.
 */
import { Page, Browser, BrowserContext } from "playwright";
import { config } from "./config";
import { LOGIN_URL, CATEGORY_LIST_URL } from "./categories";
import {
  loginWithCredentials,
  isLoggedIn,
  isSessionReady,
  waitForFaceVerifyClear,
  isOnFaceVerifyPage,
  openCategoryViaReviewClick,
} from "./session";
import { navigateWithChallengeHandling } from "./verification";
import { ensureClearOfBreakRoom } from "./breakRoom";
import {
  captureTranscript,
  inspectPortal,
  readLiveOptions,
  selectReviewChoice,
  submitReviewChoice,
  getCallFingerprint,
} from "./humanatic";
import { evaluateTranscript } from "./grok";
import {
  appendReviewLog,
  appendActivityEvent,
  loadCategoryCache,
  loadWorkerState,
  patchWorkerStatus,
  patchWorkerTarget,
  saveCategoryCache,
  computeDailyReportFor,
} from "./storage";
import { discoverReviewSelectors } from "./domDiscovery";
import { CategoryRule } from "./types";
import {
  createCdpContext,
  recoverCdpContext,
  resolveUserDataDir,
  usingRealChromeProfile,
} from "./chromeCdp";
import {
  cooldownForWindow,
  getEstClock,
  pickNextCategory,
  rankCategoriesForNow,
  recordQueueOutcome,
  classifyTrafficWindow,
} from "./trafficSchedule";
import {
  completePracticeIntro,
  countPracticeBlocks,
  isPracticeIntroPage,
} from "./practiceIntro";
import { detectPageScene, formatSceneLog, PageScene } from "./pageScene";
import {
  afterReviewCallsClick,
  clickReviewCallsCta,
  hasReviewQueueCta,
} from "./reviewQueue";
import {
  inventoryFromCache,
  pickBestWithInventory,
  pickBestGrowthWithInventory,
  scrapeLiveInventory,
} from "./categoryInventory";
import { noteGrowthSubmit, loadGrowthCatalog } from "./growthCatalog";
import {
  scrapeHumanaticLiveStats,
  accuracyLookupFromLive,
  loadHumanaticLive,
} from "./humanaticLiveStats";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Rare Humanatic mirror — only every 4h OR when local earnings crosses another $1. */
const LIVE_STATS_REFRESH_MS = 4 * 60 * 60_000;
let lastLiveStatsAt = 0;
/** Last whole-dollar floor we already synced after (local estimate). */
let lastSyncedDollarFloor = -1;
/** Stable-lite: slower poll = less CDP/CPU when idle hunting. */
const POLL_MS = 5000;
/** Short pause when inventory exists elsewhere — go grab those calls. */
const EMPTY_WITH_INVENTORY_MS = 10_000;
/** Longer pause only when ALL watched categories show 0. */
const EMPTY_ALL_DRY_MS = 40_000;
const QUEUE_NAV_COOLDOWN_MS = 18_000;
/** Cool-down after Break Room — keep short; long waits kill cents/hour. */
const BREAK_ROOM_PENALTY_MS = 20_000;
/** @deprecated alias used by older branches */
const EMPTY_COOLDOWN_MS = EMPTY_ALL_DRY_MS;

/**
 * How many times we retry the SAME category while the Category List still
 * advertises availability. The list count and what REVIEW actually serves can
 * disagree (other-language / reserved calls), so without this cap the worker
 * spins forever on "#N still shows English - X — retry in 4s".
 */
const MAX_SAME_CATEGORY_RETRIES = 12;
/** How long a category is benched after it burns through its retries. */
const CATEGORY_BENCH_MS = 5 * 60_000;

/** categoryId → timestamp until which we refuse to re-target it. */
const benchedUntil = new Map<number, number>();

const benchCategory = (categoryId: number, ms = CATEGORY_BENCH_MS) => {
  benchedUntil.set(categoryId, Date.now() + ms);
  console.warn(`[wait] Benching #${categoryId} for ${Math.round(ms / 1000)}s (list count is lying)`);
};

const isBenched = (categoryId: number): boolean => {
  const until = benchedUntil.get(categoryId);
  if (until == null) return false;
  if (Date.now() >= until) {
    benchedUntil.delete(categoryId);
    return false;
  }
  return true;
};

/** Ids we must not rotate into right now (current + benched). */
const excludedIds = (currentId: number | null): number[] => {
  const out = new Set<number>();
  if (currentId != null) out.add(currentId);
  for (const id of benchedUntil.keys()) if (isBenched(id)) out.add(id);
  return Array.from(out);
};

let lastActivityKey = "";
let lastActivityAt = 0;

const isClosedBrowserError = (e: unknown): boolean => {
  const msg = ((e as Error)?.message || String(e)).toLowerCase();
  return (
    msg.includes("has been closed") ||
    msg.includes("target closed") ||
    msg.includes("browser has been closed") ||
    msg.includes("context or browser has been closed") ||
    msg.includes("connection closed") ||
    msg.includes("protocol error")
  );
};

const setStatus = (
  state: "idle" | "waiting" | "reviewing" | "break_room" | "paused" | "error" | "stopped",
  message: string,
  extra: {
    currentUrl?: string;
    lastCallAt?: string | null;
    scene?: PageScene | null;
  } = {},
) => {
  const patch: Parameters<typeof patchWorkerStatus>[0] = {
    state,
    message,
    pid: process.pid,
  };
  if (extra.currentUrl !== undefined) patch.currentUrl = extra.currentUrl;
  if (extra.lastCallAt !== undefined) patch.lastCallAt = extra.lastCallAt;
  if (extra.scene) {
    patch.sceneKind = extra.scene.kind;
    patch.sceneAction = extra.scene.action;
    patch.sceneSummary = extra.scene.summary;
  }
  patchWorkerStatus(patch);

  // Activity feed: state changes + non-progress messages only (cuts disk thrash)
  const key = `${state}|${message}`;
  const progressLike = /Listening|waiting for options|Unlock|@\s*[\d.]+x|Next queue try/i.test(
    message,
  );
  const now = Date.now();
  const noteworthy =
    !progressLike ||
    state === "error" ||
    state === "paused" ||
    key !== lastActivityKey ||
    now - lastActivityAt > 45_000;
  if (noteworthy) {
    appendActivityEvent({
      at: new Date().toISOString(),
      state,
      message,
      url: extra.currentUrl || "",
      sceneKind: extra.scene?.kind,
      sceneAction: extra.scene?.action,
    });
    lastActivityKey = key;
    lastActivityAt = now;
  }
};

async function publishScene(
  page: Page,
  state: "idle" | "waiting" | "reviewing" | "break_room" | "paused" | "error" | "stopped",
  message?: string,
): Promise<PageScene> {
  const scene = await detectPageScene(page);
  console.log(formatSceneLog(scene));
  setStatus(state, message || scene.summary, {
    currentUrl: scene.url,
    scene,
  });
  return scene;
}

/** True when we should try opening the target category via list REVIEW click. */
function shouldOpenCategory(url: string): boolean {
  const u = url.toLowerCase();
  // Never leave an active/queued call path
  if (
    u.includes("login.cfm") ||
    u.includes("logout.cfm") ||
    u.includes("face_verify") ||
    u.includes("break_room") ||
    u.includes("hcat_intro") ||
    u.includes("category_selector") ||
    u.includes("hcat=")
  ) {
    return false;
  }
  if (u.includes("nocalls.cfm")) return true;
  if (u.includes("profile.cfm")) return true;
  if (/\/category\.cfm/i.test(u)) return true;
  // Unknown pages — open list once after cooldown
  return true;
}

/** Stay on hcat_intro until radios appear, REVIEW CALLS CTA clicked, or empty/timeout. */
async function settleOnCallIntro(page: Page): Promise<"review" | "practice" | "empty" | "gone"> {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const u = page.url().toLowerCase();
    if (u.includes("nocalls.cfm")) return "empty";
    if (u.includes("login.cfm") || u.includes("logout.cfm")) return "gone";
    if (!u.includes("hcat_intro") && !u.includes("category_selector")) {
      if (await isLiveReviewScreen(page)) return "review";
      return "gone";
    }

    if (await isLiveReviewScreen(page)) return "review";

    // Always prefer live queue CTA over re-doing practice
    if (await hasReviewQueueCta(page)) {
      setStatus("waiting", "Clicking REVIEW CALLS (skip practice)…", { currentUrl: page.url() });
      await clickReviewCallsCta(page);
      const landed = await afterReviewCallsClick(page);
      if (landed === "review") return "review";
      if (landed === "empty") return "empty";
      if (landed === "practice") {
        // Still on practice-only path without working CTA
        continue;
      }
      if (await hasCallAudio(page) || (await isLiveReviewScreen(page))) return "review";
      continue;
    }

    const practice = await countPracticeBlocks(page);
    if (practice >= 1 || (await isPracticeIntroPage(page))) {
      return "practice";
    }

    // Scroll to reveal CTA below the fold
    await page.evaluate(() => window.scrollBy(0, 500)).catch(() => undefined);
    setStatus("waiting", "On call intro — looking for REVIEW CALLS button…", {
      currentUrl: page.url(),
    });
    await sleep(1500);
  }
  return "gone";
}

async function leaveStuckIntro(page: Page, categoryId: number | null): Promise<void> {
  // Stay off Category List — soft-reload / re-open THIS category intro
  if (categoryId != null) {
    const introUrl = `https://www.humanatic.com/pages/humfun/hcat_intro.cfm?hcat=${categoryId}&x19=1`;
    console.log(`[wait] Stuck intro — soft re-open #${categoryId} (skip Category List thrash)`);
    await page.goto(introUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined);
  } else {
    console.log("[wait] Stuck intro — soft reload (no category id)");
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  }
  await sleep(1500);
}

async function rotateAfterEmpty(currentId: number | null): Promise<boolean> {
  if (currentId != null) recordQueueOutcome(currentId, "empty");

  // Prefer categories the dashboard/list already say have calls
  const cached = pickBestWithInventory(inventoryFromCache(), excludedIds(currentId));
  if (cached) {
    patchWorkerTarget({
      categoryId: cached.categoryId,
      categoryName: cached.name,
    });
    console.log(
      `[wait] Inventory jump: #${currentId ?? "?"} → #${cached.categoryId} ${cached.name} (${cached.availableLabel || cached.available} available)`,
    );
    return true;
  }

  const next = pickNextCategory(currentId, excludedIds(currentId));
  if (!next || next.categoryId === currentId) return false;
  patchWorkerTarget({
    categoryId: next.categoryId,
    categoryName: next.categoryName,
  });
  console.log(`[wait] Empty #${currentId} → rotate #${next.categoryId} ${next.categoryName}`);
  return true;
}

/**
 * Prefer hunting REVIEW CALLS on the same category intro (no Category List hop).
 * Only after MAX_SAME_CATEGORY_RETRIES does recoverFromEmpty open the list / rotate.
 */
async function huntReviewCalls(
  page: Page,
  categoryId: number,
): Promise<"review" | "empty" | "intro" | "practice" | "other"> {
  const introUrl = `https://www.humanatic.com/pages/humfun/hcat_intro.cfm?hcat=${categoryId}&x19=1`;
  const u = page.url().toLowerCase();

  // Stay on noCalls — soft-reload only (do NOT bounce to intro/practice)
  if (u.includes("nocalls.cfm")) {
    console.log("[wait] Already on noCalls — soft-reload in place (no intro bounce)");
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await sleep(1500);
    const after = page.url().toLowerCase();
    if (after.includes("nocalls.cfm")) return "empty";
    if (after.includes("review.cfm") || (await hasCallAudio(page))) return "review";
    if (await hasReviewQueueCta(page)) {
      await clickReviewCallsCta(page);
      return afterReviewCallsClick(page);
    }
    if (after.includes("hcat_intro")) return "intro";
    return "empty";
  }

  const onIntro =
    u.includes("hcat_intro") ||
    (u.includes("hcat=") && String(categoryId) === (u.match(/hcat=(\d+)/)?.[1] || ""));

  if (u.includes("category.cfm") || u.includes("profile.cfm") || !onIntro) {
    if (!u.includes("review.cfm")) {
      await page.goto(introUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined);
      await sleep(1200);
      await ensureClearOfBreakRoom(page).catch(() => undefined);
    }
  }

  if (await hasReviewQueueCta(page)) {
    await clickReviewCallsCta(page);
    return afterReviewCallsClick(page);
  }

  // Soft reload intro then try CTA again
  if (page.url().toLowerCase().includes("hcat_intro")) {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await sleep(1500);
    if (await hasReviewQueueCta(page)) {
      await clickReviewCallsCta(page);
      return afterReviewCallsClick(page);
    }
  }

  return "empty";
}

/** Soft-reload noCalls in place — Tampermonkey also reloads ~every 3s. */
const NOCALLS_POLL_MS = 3000;
/** Only after this long on noCalls do we check Category List once. */
const NOCALLS_LIST_FALLBACK_MS = 120_000;

let noCallsSince = 0;

/**
 * Rare idle scrape of Earnings / Accuracy / Leaderboard.
 * Only every 4 hours — or when local estimated earnings crosses another whole dollar.
 * Never interrupts a live review; keeps review time maximized.
 */
async function maybeRefreshHumanaticLive(page: Page): Promise<boolean> {
  const snap = loadHumanaticLive();
  const ageMs = snap.scrapedAt ? Date.now() - new Date(snap.scrapedAt).getTime() : Number.POSITIVE_INFINITY;
  const localCents = (() => {
    try {
      return computeDailyReportFor("today").estimatedEarningsCents || 0;
    } catch {
      return 0;
    }
  })();
  const dollarFloor = Math.floor(localCents / 100);

  if (lastSyncedDollarFloor < 0) {
    const siteFloor =
      snap.todayEarningsCents != null ? Math.floor(snap.todayEarningsCents / 100) : -1;
    lastSyncedDollarFloor = Math.max(siteFloor, dollarFloor >= 0 ? dollarFloor : -1);
  }

  const due4h = !snap.scrapedAt || ageMs >= LIVE_STATS_REFRESH_MS;
  const dueDollar = dollarFloor >= 1 && dollarFloor > lastSyncedDollarFloor;
  // Cap: never more often than every 20 min even on dollar bumps (avoid thrash)
  const recentlyDone =
    lastLiveStatsAt > 0 && Date.now() - lastLiveStatsAt < 20 * 60_000 && !!snap.scrapedAt;

  if ((!due4h && !dueDollar) || recentlyDone) return false;

  const u = page.url().toLowerCase();
  if (u.includes("review.cfm")) return false;
  if (await hasCallAudio(page)) return false;
  // Only while truly idle on noCalls (don't bounce mid-hunt)
  if (!u.includes("nocalls")) return false;

  const reason = dueDollar ? `crossed ~$${dollarFloor}` : due4h ? "4h timer" : "sync";
  lastLiveStatsAt = Date.now();
  const returnUrl = page.url();
  try {
    setStatus("waiting", `Quick stats sync (${reason}) — then back to calls…`, {
      currentUrl: returnUrl,
    });
    await scrapeHumanaticLiveStats(page, { returnUrl });
    lastSyncedDollarFloor = Math.max(
      lastSyncedDollarFloor,
      dollarFloor,
      Math.floor((loadHumanaticLive().todayEarningsCents || 0) / 100),
    );
    appendActivityEvent({
      at: new Date().toISOString(),
      state: "waiting",
      message: `Stats sync (${reason}) — back to reviewing`,
      url: page.url(),
    });
    return true;
  } catch (e) {
    console.warn(`[live] scrape failed: ${(e as Error).message}`);
    await navigateWithChallengeHandling(page, returnUrl).catch(() => undefined);
    return false;
  }
}

async function refreshNoCallsInPlace(page: Page): Promise<{
  waitMs: number;
  label: string;
  landedReview: boolean;
}> {
  if (!noCallsSince) noCallsSince = Date.now();
  console.log("[wait] noCalls — stay put (TM soft-reloads ~3s); worker polls lightly");
  // Light poll — don't fight Tampermonkey; just detect if page left noCalls
  await sleep(NOCALLS_POLL_MS);
  const u = page.url().toLowerCase();
  if (!u.includes("nocalls.cfm")) {
    noCallsSince = 0;
    if (u.includes("review.cfm") || (await hasCallAudio(page))) {
      return { waitMs: 0, label: "Left noCalls → live call", landedReview: true };
    }
    if (await hasReviewQueueCta(page)) {
      await clickReviewCallsCta(page);
      const landed = await afterReviewCallsClick(page);
      if (landed === "review" || (await hasCallAudio(page))) {
        return { waitMs: 0, label: "REVIEW CALLS after noCalls — reviewing", landedReview: true };
      }
    }
    return { waitMs: 0, label: "Left noCalls — continuing", landedReview: false };
  }
  // Optional soft-reload if TM didn't (stuck DOM)
  if (Date.now() - noCallsSince > 9000) {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await sleep(800);
  }
  const stuckSec = Math.round((Date.now() - noCallsSince) / 1000);
  return {
    waitMs: 0,
    label: `noCalls — soft-refreshing (~3s). On empty ${stuckSec}s`,
    landedReview: false,
  };
}

async function maybeFallbackListAfterLongEmpty(
  page: Page,
  preferredId: number | null,
): Promise<{
  waitMs: number;
  label: string;
  landedReview: boolean;
  didList: boolean;
} | null> {
  if (!noCallsSince || Date.now() - noCallsSince < NOCALLS_LIST_FALLBACK_MS) return null;
  console.log("[wait] noCalls empty ~2min — one Category List check, then back to noCalls mode");
  noCallsSince = 0;
  const grab = await grabStockFromCategoryList(page, preferredId);
  return {
    waitMs: grab.waitMs,
    label: grab.label,
    landedReview: grab.landedReview,
    didList: true,
  };
}

async function grabStockFromCategoryList(
  page: Page,
  preferredId: number | null,
): Promise<{
  waitMs: number;
  label: string;
  landedReview: boolean;
  categoryId: number | null;
}> {
  const EMPTY_LIST_RETRY_MS = 18_000;
  console.log("[wait] Rare fallback — checking Category List for live stock");
  // Finish Break Room first (respect ~20s) — hopping during slow-down causes longer bans
  if (
    page.url().toLowerCase().includes("break_room") ||
    page.url().toLowerCase().includes("categorize_slow_down")
  ) {
    console.log("[wait] Clearing Break Room before stock grab…");
    await ensureClearOfBreakRoom(page).catch(() => undefined);
    await sleep(2000);
  }
  await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined);
  await sleep(1200);
  await ensureClearOfBreakRoom(page).catch(() => undefined);

  // Humanatic slow-down page can steal the navigation — clear + retry list once
  if (page.url().toLowerCase().includes("break_room")) {
    console.warn("[wait] Hit Break Room / slow-down while opening Category List — clearing");
    await ensureClearOfBreakRoom(page).catch(() => undefined);
    await sleep(3000);
    await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined);
    await sleep(1500);
    if (page.url().toLowerCase().includes("break_room")) {
      return {
        waitMs: BREAK_ROOM_PENALTY_MS,
        label: `Break Room / slow-down — cool ${Math.round(BREAK_ROOM_PENALTY_MS / 1000)}s then grab again`,
        landedReview: false,
        categoryId: preferredId,
      };
    }
  }

  let inventory = await scrapeLiveInventory(page).catch(() => []);
  if (!inventory.length) inventory = inventoryFromCache();

  // Never claim "dry" while still stuck on Break Room / wrong page
  const here = page.url().toLowerCase();
  if (here.includes("break_room") || here.includes("categorize_slow_down")) {
    return {
      waitMs: BREAK_ROOM_PENALTY_MS,
      label: `Break Room / slow-down — cool ${Math.round(BREAK_ROOM_PENALTY_MS / 1000)}s then grab again`,
      landedReview: false,
      categoryId: preferredId,
    };
  }

  // Growth mode: highest ¢ among live stock; close payouts prefer high accuracy (LB climb)
  const withStock = inventory.filter((c) => c.available > 0 || /review/i.test(c.status));
  const pick =
    pickBestGrowthWithInventory(inventory, {
      preferId: preferredId,
      excludeIds: excludedIds(null).filter((id) => id !== preferredId),
      accuracyByName: accuracyLookupFromLive(),
      accuracyFirst: config.accuracyFirst,
    }) || withStock.sort((a, b) => (b.payoutCents || 0) - (a.payoutCents || 0))[0];

  if (!pick) {
    // Preferential click anyway if we have a target — scrape can miss REVIEW rows
    if (preferredId != null && here.includes("category.cfm")) {
      console.log(`[wait] Scrape saw 0 — still trying REVIEW on preferred #${preferredId}`);
      const result = await openCategoryViaReviewClick(page, preferredId);
      if (result !== "empty" && result !== "missing" && result !== "login") {
        if (await hasReviewQueueCta(page)) {
          await clickReviewCallsCta(page);
          const landed = await afterReviewCallsClick(page);
          if (landed === "review" || (await hasCallAudio(page))) {
            return {
              waitMs: 0,
              label: `Grabbed call via preferred #${preferredId}`,
              landedReview: true,
              categoryId: preferredId,
            };
          }
        }
        if (page.url().toLowerCase().includes("review.cfm") || (await hasCallAudio(page))) {
          return {
            waitMs: 0,
            label: `Live review via preferred #${preferredId}`,
            landedReview: true,
            categoryId: preferredId,
          };
        }
      }
    }
    // Truly dry — brief wait on list, then retry (not 90s)
    if (here.includes("category.cfm")) {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    } else {
      await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined);
    }
    return {
      waitMs: EMPTY_LIST_RETRY_MS,
      label: `Category List dry — recheck in ${Math.round(EMPTY_LIST_RETRY_MS / 1000)}s`,
      landedReview: false,
      categoryId: preferredId,
    };
  }

  patchWorkerTarget({ categoryId: pick.categoryId, categoryName: pick.name });
  console.log(
    `[growth] List stock: #${pick.categoryId} ${pick.name} · ${pick.payoutCents || "?"}¢ · ${pick.availableLabel || pick.available} — REVIEW`,
  );

  const result = await openCategoryViaReviewClick(page, pick.categoryId);
  if (result === "login") {
    return {
      waitMs: 8000,
      label: "List REVIEW bounced to login — re-auth soon",
      landedReview: false,
      categoryId: pick.categoryId,
    };
  }

  // New/higher-pay unlock often lands on practice — one pass then hunt REVIEW CALLS
  if (result === "practice" || (await isPracticeIntroPage(page).catch(() => false))) {
    console.log(`[growth] #${pick.categoryId} needs practice once — completing then hunting REVIEW CALLS`);
    await completePracticeIntro(page, {
      categoryId: pick.categoryId,
      onStatus: (message) => setStatus("reviewing", message, { currentUrl: page.url() }),
    }).catch((e) => console.warn(`[growth] practice: ${(e as Error).message}`));
    await ensureClearOfBreakRoom(page).catch(() => undefined);
  }

  // Prefer live queue over practice
  if (await hasReviewQueueCta(page)) {
    await clickReviewCallsCta(page);
    const landed = await afterReviewCallsClick(page);
    if (landed === "review" || (await hasCallAudio(page))) {
      return {
        waitMs: 0,
        label: `Grabbed live call from #${pick.categoryId} (${pick.availableLabel || pick.available})`,
        landedReview: true,
        categoryId: pick.categoryId,
      };
    }
    if (landed === "empty" || page.url().toLowerCase().includes("nocalls.cfm")) {
      // Listed stock was a ghost — try next category with stock instead of hammering same id
      const alt = withStock.find((c) => c.categoryId !== pick.categoryId);
      if (alt) {
        console.log(
          `[wait] #${pick.categoryId} → noCalls; trying next stock #${alt.categoryId} ${alt.name}`,
        );
        patchWorkerTarget({ categoryId: alt.categoryId, categoryName: alt.name });
        const altResult = await openCategoryViaReviewClick(page, alt.categoryId);
        if (altResult !== "login" && (await hasReviewQueueCta(page))) {
          await clickReviewCallsCta(page);
          const altLanded = await afterReviewCallsClick(page);
          if (altLanded === "review" || (await hasCallAudio(page))) {
            return {
              waitMs: 0,
              label: `Grabbed live call from #${alt.categoryId} after #${pick.categoryId} empty`,
              landedReview: true,
              categoryId: alt.categoryId,
            };
          }
        }
      }
      return {
        waitMs: EMPTY_LIST_RETRY_MS,
        label: `#${pick.categoryId} clicked but noCalls — list recheck in ${Math.round(EMPTY_LIST_RETRY_MS / 1000)}s`,
        landedReview: false,
        categoryId: pick.categoryId,
      };
    }
  }

  if (page.url().toLowerCase().includes("review.cfm") || (await hasCallAudio(page))) {
    return {
      waitMs: 0,
      label: `Live review after list REVIEW #${pick.categoryId}`,
      landedReview: true,
      categoryId: pick.categoryId,
    };
  }

  // Landed intro/practice — try hunt once, don't sit forever
  if (pick.categoryId != null) {
    const hunted = await huntReviewCalls(page, pick.categoryId);
    if (hunted === "review") {
      return {
        waitMs: 0,
        label: `Live call via hunt #${pick.categoryId}`,
        landedReview: true,
        categoryId: pick.categoryId,
      };
    }
  }

  return {
    waitMs: EMPTY_LIST_RETRY_MS,
    label: `#${pick.categoryId} listed ${pick.availableLabel || pick.available} — retry grab in ${Math.round(EMPTY_LIST_RETRY_MS / 1000)}s`,
    landedReview: false,
    categoryId: pick.categoryId,
  };
}

/**
 * On empty: prefer staying on noCalls (TM reloads ~3s). Category List only after ~2min.
 */
async function recoverFromEmpty(
  page: Page,
  currentId: number | null,
  streak = 0,
): Promise<{
  jumped: boolean;
  waitMs: number;
  label: string;
  rotated: boolean;
  landedReview?: boolean;
}> {
  if (page.url().toLowerCase().includes("nocalls.cfm")) {
    const listTry = await maybeFallbackListAfterLongEmpty(page, currentId);
    if (listTry) {
      return {
        jumped: listTry.didList,
        rotated: false,
        waitMs: listTry.waitMs,
        label: listTry.label,
        landedReview: listTry.landedReview,
      };
    }
    const r = await refreshNoCallsInPlace(page);
    return {
      jumped: false,
      rotated: false,
      waitMs: r.waitMs,
      label: r.label,
      landedReview: r.landedReview,
    };
  }

  // First miss on intro: quick hunt once
  if (currentId != null && streak < 2) {
    console.log(`[wait] Quick REVIEW CALLS hunt #${currentId}`);
    const landed = await huntReviewCalls(page, currentId);
    if (landed === "review") {
      noCallsSince = 0;
      return {
        jumped: true,
        rotated: false,
        waitMs: 0,
        label: `Live call on #${currentId} — reviewing`,
        landedReview: true,
      };
    }
    if (page.url().toLowerCase().includes("nocalls.cfm")) {
      const r = await refreshNoCallsInPlace(page);
      return {
        jumped: false,
        rotated: false,
        waitMs: r.waitMs,
        label: r.label,
        landedReview: r.landedReview,
      };
    }
    return {
      jumped: true,
      rotated: false,
      waitMs: 5000,
      label: `#${currentId} empty — staying off Category List`,
    };
  }

  // Rare: already on category list with streak — one stock grab
  if (page.url().toLowerCase().includes("category.cfm")) {
    const grab = await grabStockFromCategoryList(page, currentId);
    return {
      jumped: true,
      rotated: grab.categoryId != null && grab.categoryId !== currentId,
      waitMs: grab.waitMs,
      label: grab.label,
      landedReview: grab.landedReview,
    };
  }

  return {
    jumped: false,
    rotated: false,
    waitMs: NOCALLS_POLL_MS,
    label: "Empty — wait for noCalls/TM refresh",
  };
}

async function ensureLogin(page: Page) {
  if (await isSessionReady(page)) return;
  await navigateWithChallengeHandling(page, LOGIN_URL);
  await sleep(1000);
  if (!(await isLoggedIn(page))) {
    if (!(await loginWithCredentials(page))) {
      throw new Error("Auto-login failed");
    }
  }
  if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page);
}

/** True when page looks like a real call review (not practice quiz / category list / noCalls). */
async function isLiveReviewScreen(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (
    url.includes("login.cfm") ||
    url.includes("logout.cfm") ||
    url.includes("nocalls.cfm") ||
    url.includes("break_room") ||
    url.includes("category.cfm") ||
    url.includes("face_verify")
  ) {
    return false;
  }

  return page.evaluate(() => {
    const practiceBlocks = document.querySelectorAll(".practice-review").length;
    if (practiceBlocks >= 1) return false;
    const bodyText = (document.body?.innerText || "").toLowerCase();
    if (bodyText.includes("practice questions")) return false;

    const humfun = document.querySelectorAll(".humfun-options-list-item").length;
    if (humfun >= 2) return true;

    const radios = document.querySelectorAll('input[type="radio"]').length;
    const audio = document.querySelector("audio, audio.call-audio");
    if (radios >= 2 && (audio || bodyText.includes("submit"))) return true;
    if (radios >= 3) return true;
    if (/\/x19\/review\.cfm/i.test(location.href) && audio) return true;
    return false;
  });
}

/** Audio is on page — do NOT navigate away (abandoning a live call). */
async function hasCallAudio(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      if (document.querySelectorAll(".practice-review").length >= 1) return false;
      return !!document.querySelector("audio, audio.call-audio");
    })
    .catch(() => false);
}

/**
 * Full live-call path:
 * 1) Detect Humfun/radio review UI
 * 2) Listen through audio at 2–3x (required — early submit → red error)
 * 3) Wait until options unlock
 * 4) Whisper + Grok + submit
 */
async function holdAndReviewCall(
  page: Page,
  practiceMode: boolean,
  timeoutMs = 240000,
): Promise<"ok" | "skipped" | "timeout"> {
  const {
    isHumfunReviewPage,
    countHumfunOptions,
    listenThroughCall,
    waitUntilOptionsUnlocked,
    optionsStillLocked,
  } = await import("./humfunReview");
  const { setPageAudioMuted, showBrowserWindow } = await import("./browserWatch");

  const deadline = Date.now() + timeoutMs;
  if (loadWorkerState().target.watchBrowser) {
    await showBrowserWindow(page);
    await setPageAudioMuted(page, false);
  }

  setStatus("reviewing", "Live call — listening before any selection (required by Humanatic)", {
    currentUrl: page.url(),
  });

  // Wait until review UI or audio is present
  while (Date.now() < deadline) {
    const humfun = await isHumfunReviewPage(page);
    const optionsN = humfun
      ? await countHumfunOptions(page)
      : await page.locator('input[type="radio"]').count().catch(() => 0);
    const hasAudio = await hasCallAudio(page);

    if (humfun || (await isLiveReviewScreen(page)) || hasAudio) {
      const wantHear = () => !!loadWorkerState().target.watchBrowser;
      if (wantHear()) {
        await showBrowserWindow(page);
        await setPageAudioMuted(page, false);
      }
      // Always finish the recording first
      let lastWatchApply = 0;
      const listen = await listenThroughCall(page, {
        muted: () => !wantHear(),
        playbackRate: config.reviewPlaybackRate,
        onProgress: (msg) => {
          setStatus("reviewing", msg, { currentUrl: page.url() });
          // Mid-listen Watch click — restore Chrome without waiting for call end
          if (wantHear() && Date.now() - lastWatchApply > 8000) {
            lastWatchApply = Date.now();
            void showBrowserWindow(page);
            void setPageAudioMuted(page, false);
          }
        },
        timeoutMs: Math.max(30000, deadline - Date.now()),
      });

      if (listen === "timeout") {
        setStatus("reviewing", "Listen timeout — still waiting (will not submit early)", {
          currentUrl: page.url(),
        });
      }

      if (humfun || optionsN >= 2 || (await countHumfunOptions(page)) >= 2) {
        const unlocked = await waitUntilOptionsUnlocked(page, 60000, (msg) =>
          setStatus("reviewing", msg, { currentUrl: page.url() }),
        );
        if (!unlocked && (await optionsStillLocked(page))) {
          setStatus("reviewing", "Options still locked after listen — waiting more…", {
            currentUrl: page.url(),
          });
          await sleep(5000);
          if (await optionsStillLocked(page)) {
            // One more short wait — never force-submit while locked
            await waitUntilOptionsUnlocked(page, 30000);
          }
        }
      } else {
        // Classic radios may appear after listen
        for (let i = 0; i < 20; i++) {
          if (await isLiveReviewScreen(page)) break;
          await sleep(1000);
        }
      }

      // Audio may already be finished — treat clickable cards as unlocked even if
      // tip text still mentions "Selections will be available" in the DOM.
      const stillLocked = await optionsStillLocked(page);
      const optionCount = await countHumfunOptions(page);
      if (stillLocked && optionCount < 2) {
        setStatus(
          "reviewing",
          "Still locked (Humanatic: finish listening) — not submitting yet",
          { currentUrl: page.url() },
        );
        await sleep(3000);
        continue;
      }
      if (stillLocked && optionCount >= 2) {
        // Overlay reported locked but cards are present — recheck once, then proceed
        await sleep(800);
      }

      if ((await isLiveReviewScreen(page)) || optionCount >= 2) {
        const result = await reviewCurrentCall(page, practiceMode);
        return result;
      }
    }

    setStatus(
      "reviewing",
      `On call page — waiting for player/options (${optionsN} choices)…`,
      { currentUrl: page.url() },
    );
    await sleep(2000);
    if (!(await hasCallAudio(page)) && optionsN < 2 && !(await isHumfunReviewPage(page))) {
      return "timeout";
    }
  }
  return "timeout";
}

async function reviewCurrentCall(page: Page, practiceMode: boolean): Promise<"ok" | "skipped"> {
  const started = Date.now();
  setStatus("reviewing", "Review UI ready — transcribing & deciding (listen already done)", {
    currentUrl: page.url(),
  });

  // Soft gate only — tip text can linger after unlock; cards + inactive overlay decide
  const { optionsStillLocked, isHumfunReviewPage, countHumfunOptions } = await import(
    "./humfunReview"
  );
  if (
    (await isHumfunReviewPage(page)) &&
    (await optionsStillLocked(page)) &&
    (await countHumfunOptions(page)) < 2
  ) {
    appendReviewLog({
      call_id: `call-${Date.now()}`,
      timestamp: new Date().toISOString(),
      category_id: "locked",
      selected_option_id: "",
      confidence: 0,
      reasoning: "Options locked — must finish listening first",
      latency_ms: Date.now() - started,
      status: "skipped_error",
    });
    return "skipped";
  }

  await discoverReviewSelectors(page);
  const metadata = await inspectPortal(page);
  // Prefer dashboard/worker target when review.cfm has no hcat in URL
  const workerTarget = loadWorkerState().target;
  if (workerTarget.categoryId != null) {
    const id = String(workerTarget.categoryId);
    if (!/^\d+$/.test(metadata.categoryId) || metadata.categoryId === "unknown-category") {
      metadata.categoryId = id;
    }
    if (!metadata.categoryName && workerTarget.categoryName) {
      metadata.categoryName = workerTarget.categoryName;
    }
  }
  let categoryRule = loadCategoryCache().find((c) => c.category_id === metadata.categoryId);
  const liveOptions = await readLiveOptions(page);

  if (!categoryRule) {
    categoryRule = {
      category_id: metadata.categoryId,
      category_name: metadata.categoryName || `Category ${metadata.categoryId}`,
      rules: liveOptions.map((o) => `- ${o.label}`).join("\n"),
      options: liveOptions,
    };
  } else if (liveOptions.length) {
    categoryRule = { ...categoryRule, options: liveOptions };
  }

  if (!categoryRule.options.length) {
    appendReviewLog({
      call_id: `call-${Date.now()}`,
      timestamp: new Date().toISOString(),
      category_id: metadata.categoryId,
      category_name: categoryRule.category_name,
      selected_option_id: "",
      confidence: 0,
      reasoning: "No options",
      latency_ms: Date.now() - started,
      status: "skipped_no_options",
    });
    return "skipped";
  }

  const cache = loadCategoryCache().filter((c) => c.category_id !== categoryRule!.category_id);
  cache.push(categoryRule as CategoryRule);
  saveCategoryCache(cache);

  let transcript = "";
  try {
    const { getTranscribeCooldownRemainingMs, canTranscribeNow } = await import("./transcribeProviders");
    const coolLeft = getTranscribeCooldownRemainingMs();
    if (!canTranscribeNow()) {
      const waitSec = Math.ceil(Math.max(coolLeft, 15_000) / 1000);
      appendReviewLog({
        call_id: `call-${Date.now()}`,
        timestamp: new Date().toISOString(),
        category_id: metadata.categoryId,
        category_name: categoryRule.category_name,
        selected_option_id: "",
        confidence: 0,
        reasoning: `STT resting ${waitSec}s (all free providers cooling) — skipped without API call`,
        latency_ms: Date.now() - started,
        status: "skipped_no_transcript",
      });
      setStatus(
        "reviewing",
        `Speech-to-text resting ${waitSec}s — free providers cooling`,
        { currentUrl: page.url() },
      );
      await sleep(Math.min(coolLeft || 20_000, 120_000));
      return "skipped";
    }
    transcript = await captureTranscript(
      page,
      categoryRule.options.map((o) => o.label || ""),
    );
  } catch (e) {
    appendReviewLog({
      call_id: `call-${Date.now()}`,
      timestamp: new Date().toISOString(),
      category_id: metadata.categoryId,
      category_name: categoryRule.category_name,
      selected_option_id: "",
      confidence: 0,
      reasoning: `Transcript failed: ${(e as Error).message}`,
      latency_ms: Date.now() - started,
      status: "skipped_no_transcript",
    });
    console.warn(`[wait] No usable transcript — skipping without submitting`);
    // Short cool-down; free STT waterfall usually recovers without a long wait
    const { getTranscribeCooldownRemainingMs } = await import("./transcribeProviders");
    const cool = Math.max(getTranscribeCooldownRemainingMs(), 12_000);
    setStatus(
      "waiting",
      `Transcript skip — cooling ${Math.round(cool / 1000)}s before next call`,
      { currentUrl: page.url() },
    );
    await sleep(Math.min(cool, 60_000));
    return "skipped";
  }

  console.log(
    `[wait] Review cat=${categoryRule.category_name} options=${categoryRule.options.length} transcript=${transcript.length}`,
  );

  let decision;
  try {
    decision = await evaluateTranscript(categoryRule, transcript);
  } catch (e) {
    const msg = (e as Error).message || "";
    appendReviewLog({
      call_id: `call-${Date.now()}`,
      timestamp: new Date().toISOString(),
      category_id: metadata.categoryId,
      category_name: categoryRule.category_name,
      selected_option_id: "",
      confidence: 0,
      reasoning: msg,
      latency_ms: Date.now() - started,
      status: "skipped_error",
    });
    // Hold the live call — do NOT leave/refresh. Wait for cool-down then retry in outer loop.
    const { getLlmCooldownRemainingMs } = await import("./grok");
    const waitMs = Math.max(getLlmCooldownRemainingMs(), 20_000);
    setStatus(
      "reviewing",
      `LLM unavailable — holding call ${Math.round(waitMs / 1000)}s (not refreshing)`,
      { currentUrl: page.url() },
    );
    console.warn(`[wait] Holding live call ${Math.round(waitMs / 1000)}s after eval failure`);
    await sleep(Math.min(waitMs, 90_000));
    return "skipped";
  }

  // Heuristic decisions are keyword guesses made while the LLM is rate-limited.
  // They are gated by an explicit opt-in, NOT by the confidence number.
  if (decision.source === "heuristic" && !config.heuristicSubmit) {
    appendReviewLog({
      call_id: `call-${Date.now()}`,
      timestamp: new Date().toISOString(),
      category_id: metadata.categoryId,
      category_name: categoryRule.category_name,
      selected_option_id: decision.selected_option_id,
      confidence: decision.confidence,
      reasoning: `${decision.reasoning} | BLOCKED: set HEURISTIC_SUBMIT=1 to allow`,
      latency_ms: Date.now() - started,
      status: "skipped_heuristic_blocked",
    });
    console.warn("[wait] Heuristic decision blocked (HEURISTIC_SUBMIT=0) — skip");
    return "skipped";
  }

  // Accuracy-first: raise the bar further on categories you're already scoring poorly on
  let needConf = config.confidenceThreshold;
  if (config.accuracyFirst) {
    const siteAcc = accuracyLookupFromLive();
    const catAcc = (() => {
      const name = (categoryRule.category_name || "").toLowerCase();
      for (const [k, v] of siteAcc) {
        if (name.includes(k) || k.includes(name.split(/[:\-]/)[0] || "")) return v;
      }
      return null as number | null;
    })();
    if (catAcc != null && catAcc < 20) needConf = Math.max(needConf, 0.91);
    else if (catAcc != null && catAcc < 40) needConf = Math.max(needConf, 0.9);
  }

  if (decision.source !== "heuristic" && decision.confidence < needConf) {
    appendReviewLog({
      call_id: `call-${Date.now()}`,
      timestamp: new Date().toISOString(),
      category_id: metadata.categoryId,
      category_name: categoryRule.category_name,
      selected_option_id: decision.selected_option_id,
      confidence: decision.confidence,
      reasoning: `${decision.reasoning} | need≥${needConf}`,
      latency_ms: Date.now() - started,
      status: "skipped_low_confidence",
    });
    console.warn(`[wait] Low confidence ${decision.confidence} < ${needConf} — skip (accuracy-first)`);
    return "skipped";
  }

  await sleep(800 + Math.floor(Math.random() * 1200));

  if (practiceMode) {
    await selectReviewChoice(page, decision.selected_option_id);
    appendReviewLog({
      call_id: metadata.callId || `call-${Date.now()}`,
      timestamp: new Date().toISOString(),
      category_id: metadata.categoryId,
      category_name: categoryRule.category_name,
      selected_option_id: decision.selected_option_id,
      confidence: decision.confidence,
      reasoning: `[PRACTICE] ${decision.reasoning}`,
      latency_ms: Date.now() - started,
      status: "practice_selected",
    });
    console.log(`[wait] PRACTICE selected ${decision.selected_option_id}`);
  } else {
    try {
      await submitReviewChoice(page, decision.selected_option_id);
      appendReviewLog({
        call_id: metadata.callId || `call-${Date.now()}`,
        timestamp: new Date().toISOString(),
        category_id: metadata.categoryId,
        category_name: categoryRule.category_name,
        selected_option_id: decision.selected_option_id,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        latency_ms: Date.now() - started,
        status: "submitted",
      });
      noteGrowthSubmit(Number(metadata.categoryId) || 0);
      console.log(`[wait] SUBMITTED ${decision.selected_option_id} conf=${decision.confidence}`);
    } catch (e) {
      const msg = (e as Error).message || "";
      // Row submit navigates off review.cfm — treat as success when we left review
      const leftReview = !/review\.cfm/i.test(page.url());
      if (leftReview || /Execution context was destroyed|Target closed|navigation/i.test(msg)) {
        appendReviewLog({
          call_id: metadata.callId || `call-${Date.now()}`,
          timestamp: new Date().toISOString(),
          category_id: metadata.categoryId,
          category_name: categoryRule.category_name,
          selected_option_id: decision.selected_option_id,
          confidence: decision.confidence,
          reasoning: `${decision.reasoning} (nav after submit)`,
          latency_ms: Date.now() - started,
          status: "submitted",
        });
        noteGrowthSubmit(Number(metadata.categoryId) || 0);
        console.log(
          `[wait] SUBMITTED ${decision.selected_option_id} conf=${decision.confidence} (post-nav)`,
        );
      } else {
        throw e;
      }
    }
  }

  setStatus("waiting", practiceMode ? "Practice select done — waiting for next" : "Submitted — waiting for next", {
    currentUrl: page.url(),
    lastCallAt: new Date().toISOString(),
  });

  // Human cooldown
  await sleep(4000 + Math.floor(Math.random() * 5000));
  return "ok";
}

async function main() {
  console.log("[wait] Indus Web Reviewer — wait-mode worker starting (stable-lite)…");
  const userDataDir = resolveUserDataDir();
  console.log(
    usingRealChromeProfile()
      ? `[wait] Chrome profile: ${userDataDir} [${config.chromeProfileDirectory}]`
      : `[wait] Automation profile: ${userDataDir}`,
  );
  setStatus("waiting", "Launching / attaching Chrome profile…", { currentUrl: "" });

  // Prefer calmer soft-assist cadence
  try {
    const { target } = loadWorkerState();
    if ((target.refreshSeconds || 75) < 90) {
      patchWorkerTarget({ refreshSeconds: 90 });
    }
  } catch {
    /* ignore */
  }

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page!: Page;

  const attachBrowser = async (mode: "launch" | "recover") => {
    setStatus(
      "waiting",
      mode === "recover" ? "Chrome died — relaunching cleanly…" : "Launching / attaching Chrome profile…",
      { currentUrl: "" },
    );
    const cdp =
      mode === "recover" ? await recoverCdpContext(browser || null) : await createCdpContext();
    browser = cdp.browser;
    context = cdp.context;
    if (!context) throw new Error("No Chrome context");
    page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());
    await ensureLogin(page);
    await sleep(4000 + Math.floor(Math.random() * 2000));
  };

  try {
    await attachBrowser("launch");
  } catch (err) {
    const msg = (err as Error).message || String(err);
    setStatus("error", `Chrome launch failed: ${msg}`);
    throw err;
  }

  // No boot trip to Earnings/Accuracy/LB — review first. Stats sync only every 4h or +$1.
  lastLiveStatsAt = loadHumanaticLive().scrapedAt
    ? new Date(loadHumanaticLive().scrapedAt).getTime()
    : 0;
  console.log("[wait] Focus mode: reviewing calls; Humanatic stats sync = 4h or each +$1");

  const insight = rankCategoriesForNow();
  console.log(
    `[wait] Traffic @ ${insight.clock.label} window=${insight.window} peak=${insight.peak} prime=${insight.primeBonus}`,
  );
  console.log(`[wait] Tip: ${insight.tip}`);
  console.log(
    `[wait] Ranked: ${insight.ranked
      .slice(0, 4)
      .map((r) => `#${r.categoryId} ${r.name}(${r.score})`)
      .join(" → ")}`,
  );

  const { target: bootTarget } = loadWorkerState();
  const bestNow = pickBestGrowthWithInventory(inventoryFromCache(), {
    preferId: bootTarget.categoryId,
    accuracyByName: accuracyLookupFromLive(),
    accuracyFirst: config.accuracyFirst,
  });
  if (bestNow && bestNow.available > 0) {
    const currentAvail =
      inventoryFromCache().find((c) => c.categoryId === bootTarget.categoryId)?.available || 0;
    const currentPay =
      inventoryFromCache().find((c) => c.categoryId === bootTarget.categoryId)?.payoutCents || 0;
    // Switch if no stock locally, or higher-pay stock exists (growth)
    if (
      bootTarget.categoryId == null ||
      currentAvail <= 0 ||
      (bestNow.payoutCents || 0) > currentPay + 0.15
    ) {
      console.log(
        `[growth] Boot pick: #${bestNow.categoryId} ${bestNow.name} · ${bestNow.payoutCents || "?"}¢ (${bestNow.availableLabel || bestNow.available})`,
      );
      patchWorkerTarget({ categoryId: bestNow.categoryId, categoryName: bestNow.name });
    }
  } else if (bootTarget.autoRotate !== false && bootTarget.categoryId == null && insight.ranked[0]) {
    const top = insight.ranked[0];
    console.log(`[wait] Auto-pick top category for window: #${top.categoryId} ${top.name}`);
    patchWorkerTarget({ categoryId: top.categoryId, categoryName: top.name });
  }

  const catalog = loadGrowthCatalog();
  const topPay = catalog.filter((c) => c.payoutCents > 0).slice(0, 3);
  if (topPay.length) {
    console.log(
      `[growth] Catalog payout leaders: ${topPay
        .map((c) => `#${c.categoryId} ${c.name} ${c.payoutCents}¢`)
        .join(" · ")}`,
    );
  }

  setStatus("waiting", `${insight.tip} — growth mode (accuracy + highest ¢ stock)`, {
    currentUrl: page!.url(),
  });

  let lastFingerprint = "";
  let lastQueueNavAt = 0;
  let nextCooldownMs = QUEUE_NAV_COOLDOWN_MS;
  let breakQuietUntil = 0;
  let emptyStreak = 0;
  /** Live mode: avoid endless practice loops — at most one practice pass per category window. */
  let lastPracticeAt = 0;
  let practicePassesThisCat = 0;
  let practiceCatId: number | null = null;
  let lastWatchBrowser = !!loadWorkerState().target.watchBrowser;
  let consecutiveLoopErrors = 0;

  const maybeCompletePractice = async (categoryId: number | null) => {
    if (practiceCatId !== categoryId) {
      practiceCatId = categoryId;
      practicePassesThisCat = 0;
    }
    // Live earnings mode: only attempt practice once, then keep hunting REVIEW CALLS
    const liveMode = !loadWorkerState().target.practiceMode;
    if (liveMode && practicePassesThisCat >= 1 && Date.now() - lastPracticeAt < 20 * 60_000) {
      console.log("[wait] Skip practice loop — hunt REVIEW CALLS instead (live mode)");
      if (categoryId != null) {
        await huntReviewCalls(page, categoryId);
      } else if (page.url().toLowerCase().includes("hcat_intro")) {
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        await sleep(1500);
      }
      return "skipped" as const;
    }
    setStatus("reviewing", "Practice once then back to REVIEW CALLS hunt…", {
      currentUrl: page.url(),
    });
    await completePracticeIntro(page, {
      categoryId,
      onStatus: (message) => setStatus("reviewing", message, { currentUrl: page.url() }),
    });
    practicePassesThisCat += 1;
    lastPracticeAt = Date.now();
    await ensureClearOfBreakRoom(page).catch(() => undefined);
    if (await hasReviewQueueCta(page)) {
      await clickReviewCallsCta(page);
      await afterReviewCallsClick(page);
    }
    return "done" as const;
  };

  /**
   * Single entry point for empty-queue recovery. Owns the consecutive-failure
   * counter so every call site participates in the circuit breaker — the old
   * code incremented `emptyStreak` in five places and never read it once.
   */
  const runRecovery = async (categoryId: number | null) => {
    const recovery = await recoverFromEmpty(page, categoryId, emptyStreak);
    if (recovery.landedReview) {
      emptyStreak = 0;
    } else if (recovery.rotated) {
      emptyStreak = 0;
    } else {
      emptyStreak += 1;
    }
    return recovery;
  };

  /** Apply empty-queue recovery: if we landed a live review, resume immediately. */
  const applyRecovery = async (
    categoryId: number | null,
    scene: Awaited<ReturnType<typeof publishScene>>,
  ) => {
    const recovery = await runRecovery(categoryId);
    setStatus("waiting", recovery.label, { currentUrl: page.url(), scene });
    if (recovery.landedReview) {
      lastQueueNavAt = Date.now();
      nextCooldownMs = 2000;
      return recovery;
    }
    await sleep(recovery.waitMs);
    lastQueueNavAt = 0;
    nextCooldownMs = recovery.jumped ? 5000 : QUEUE_NAV_COOLDOWN_MS;
    return recovery;
  };

  while (true) {
    const { target } = loadWorkerState();

    if (!target.enabled) {
      setStatus("idle", "Target disabled from dashboard — idle", { currentUrl: page.url() });
      await sleep(3000);
      continue;
    }

    if (target.paused) {
      setStatus("paused", "Paused — click Resume on the dashboard to continue", {
        currentUrl: page.url(),
      });
      await sleep(2000);
      continue;
    }

    // Watch mode toggles: show/hear vs quiet minimize
    try {
      const { showBrowserWindow, minimizeBrowserWindow, setPageAudioMuted } = await import(
        "./browserWatch"
      );
      if (target.watchBrowser) {
        if (!lastWatchBrowser) {
          console.log("[wait] Watch mode ON — restoring Chrome on-screen + unmuting");
        }
        // Re-apply every loop — off-screen chrome or OS minimize can undo a single restore
        await showBrowserWindow(page);
        await setPageAudioMuted(page, false);
      } else if (lastWatchBrowser) {
        console.log("[wait] Watch mode OFF — muting + minimizing");
        await setPageAudioMuted(page, true);
        if (config.backgroundChrome) await minimizeBrowserWindow(page);
      }
      lastWatchBrowser = !!target.watchBrowser;
    } catch (e) {
      console.warn(`[wait] Watch toggle failed: ${(e as Error).message}`);
    }

    try {
      consecutiveLoopErrors = 0;
      const scene = await publishScene(page, "waiting");

      switch (scene.action) {
        case "login": {
          setStatus("waiting", "Session lost — re-login (backing off)", {
            currentUrl: scene.url,
            scene,
          });
          await ensureLogin(page);
          await sleep(8000 + Math.floor(Math.random() * 4000));
          lastQueueNavAt = Date.now();
          nextCooldownMs = EMPTY_COOLDOWN_MS;
          continue;
        }

        case "wait_face": {
          setStatus("waiting", scene.summary, { currentUrl: scene.url, scene });
          await waitForFaceVerifyClear(page);
          continue;
        }

        case "wait_challenge": {
          setStatus("waiting", scene.summary, { currentUrl: scene.url, scene });
          await sleep(2000);
          continue;
        }

        case "clear_break_room": {
          setStatus("break_room", scene.summary, { currentUrl: scene.url, scene });
          await ensureClearOfBreakRoom(page);
          // Humanatic penalizes rapid category hopping — sit quiet after Break Room
          breakQuietUntil = Date.now() + BREAK_ROOM_PENALTY_MS;
          lastQueueNavAt = Date.now();
          nextCooldownMs = BREAK_ROOM_PENALTY_MS;
          setStatus(
            "waiting",
            `Break Room cleared — cooling down ${Math.round(BREAK_ROOM_PENALTY_MS / 1000)}s (avoids another slow-down)`,
            { currentUrl: page.url(), scene },
          );
          await sleep(8000);
          continue;
        }

        case "complete_practice": {
          // Prefer live queue whenever CTA is present
          if (await hasReviewQueueCta(page)) {
            setStatus("waiting", "REVIEW CALLS present — skipping practice quiz", {
              currentUrl: page.url(),
              scene,
            });
            await clickReviewCallsCta(page);
            const landed = await afterReviewCallsClick(page);
            if (landed === "empty") {
              await applyRecovery(target.categoryId, scene);
              continue;
            }
            if (landed === "review" || (await hasCallAudio(page))) {
              emptyStreak = 0;
              continue;
            }
            continue;
          }
          await maybeCompletePractice(
            target.categoryId ??
              (scene.categoryId != null ? Number(scene.categoryId) : null),
          );
          lastQueueNavAt = Date.now();
          nextCooldownMs = 10000;
          continue;
        }

        case "click_review_calls": {
          setStatus("waiting", scene.summary, { currentUrl: scene.url, scene });
          const clicked = await clickReviewCallsCta(page);
          if (!clicked) {
            await page.evaluate(() => window.scrollBy(0, 800)).catch(() => undefined);
            await sleep(800);
            await clickReviewCallsCta(page);
          }
          const landed = await afterReviewCallsClick(page);
          if (landed === "empty") {
            if (target.categoryId != null) recordQueueOutcome(target.categoryId, "empty");
            await applyRecovery(target.categoryId, scene);
            continue;
          }
          if (landed === "review") {
            emptyStreak = 0;
            continue;
          }
          // Audio may have started with radios still loading
          if (await hasCallAudio(page)) {
            emptyStreak = 0;
            const held = await holdAndReviewCall(page, target.practiceMode);
            if (held === "ok" && target.categoryId != null) recordQueueOutcome(target.categoryId, "hit");
            continue;
          }
          if (landed === "practice") {
            // Still on intro with practice — try CTA again before answering quiz
            if (await hasReviewQueueCta(page)) {
              setStatus("waiting", "Still on intro — click REVIEW CALLS again (skip practice)", {
                currentUrl: page.url(),
                scene,
              });
              await clickReviewCallsCta(page);
              const again = await afterReviewCallsClick(page);
              if (again === "empty") {
                await applyRecovery(target.categoryId, scene);
            }
              continue;
            }
            setStatus("reviewing", "Practice gate with no CTA — at most once, then hunt…", {
              currentUrl: page.url(),
              scene,
            });
            await maybeCompletePractice(target.categoryId);
          }
          continue;
        }

        case "hold_call": {
          emptyStreak = 0;
          const held = await holdAndReviewCall(page, target.practiceMode);
          if (held === "ok" && target.categoryId != null) recordQueueOutcome(target.categoryId, "hit");
          if (held === "timeout") {
            setStatus("waiting", "Call UI timed out waiting for options — staying put briefly", {
              currentUrl: page.url(),
              scene,
            });
            await sleep(5000);
          }
          continue;
        }

        case "review_call": {
          emptyStreak = 0;
          // Always listen-through first on live pages (Humfun locks early submits)
          const held = await holdAndReviewCall(page, target.practiceMode);
          if (held === "ok" && target.categoryId != null) recordQueueOutcome(target.categoryId, "hit");
          if (held === "timeout") {
            setStatus("waiting", "Call UI timed out — staying put briefly", {
              currentUrl: page.url(),
              scene,
            });
            await sleep(5000);
          }
          continue;
        }

        case "wait_empty": {
          // Stay on noCalls — TM soft-reloads every 3s. List only after ~2min empty.
          if (target.categoryId != null) recordQueueOutcome(target.categoryId, "empty");
          const quietLeftBr = Math.max(0, breakQuietUntil - Date.now());
          if (quietLeftBr > 0) {
            setStatus(
              "waiting",
              `After Break Room — wait ${Math.ceil(quietLeftBr / 1000)}s (no hopping)`,
              { currentUrl: page.url(), scene },
            );
            await sleep(Math.min(5000, quietLeftBr));
            continue;
          }
          // Rare stats sync only (4h or +$1) — never distract from hunting calls
          if (await maybeRefreshHumanaticLive(page)) {
            await sleep(800);
            continue;
          }
          const listTry = await maybeFallbackListAfterLongEmpty(page, target.categoryId);
          if (listTry) {
            setStatus("waiting", listTry.label, { currentUrl: page.url(), scene });
            if (listTry.landedReview) {
              emptyStreak = 0;
              noCallsSince = 0;
              continue;
            }
            await sleep(Math.min(listTry.waitMs || NOCALLS_POLL_MS, 18_000));
            continue;
          }
          const r = await refreshNoCallsInPlace(page);
          setStatus("waiting", r.label, { currentUrl: page.url(), scene });
          if (r.landedReview) {
            emptyStreak = 0;
            noCallsSince = 0;
            lastQueueNavAt = Date.now();
            continue;
          }
          emptyStreak += 1;
          lastQueueNavAt = Date.now();
          nextCooldownMs = NOCALLS_POLL_MS;
          continue;
        }

        case "open_category":
        case "wait":
        case "idle":
        default: {
          // NEVER leave a playing / loading live call
          if (scene.kind === "live_review" || (await hasCallAudio(page))) {
            const held = await holdAndReviewCall(page, target.practiceMode);
            if (held === "ok" && target.categoryId != null) recordQueueOutcome(target.categoryId, "hit");
            continue;
          }

          if (
            scene.kind === "call_intro" ||
            scene.kind === "practice_intro" ||
            scene.url.toLowerCase().includes("hcat_intro") ||
            scene.url.toLowerCase().includes("category_selector")
          ) {
            const settled = await settleOnCallIntro(page);
            if (settled === "review") continue;
            if (settled === "practice") {
              // settleOnCallIntro only returns practice when CTA is missing
              if (await hasReviewQueueCta(page)) {
                await clickReviewCallsCta(page);
                await afterReviewCallsClick(page);
                lastQueueNavAt = Date.now();
                nextCooldownMs = 8000;
                continue;
              }
              await maybeCompletePractice(target.categoryId);
              lastQueueNavAt = Date.now();
              nextCooldownMs = 10000;
              continue;
            }
            if (settled === "empty") {
              if (target.categoryId != null) recordQueueOutcome(target.categoryId, "empty");
              await applyRecovery(target.categoryId, scene);
              continue;
            }
            // gone / timeout on instructions-only intro
            await leaveStuckIntro(page, target.categoryId);
            lastQueueNavAt = Date.now();
            nextCooldownMs = QUEUE_NAV_COOLDOWN_MS;
            continue;
          }

          const quietLeft = Math.max(0, breakQuietUntil - Date.now());
          const canOpen =
            target.categoryId != null &&
            shouldOpenCategory(page.url()) &&
            Date.now() - lastQueueNavAt >= nextCooldownMs &&
            quietLeft <= 0 &&
            !(await hasCallAudio(page));

          if (!canOpen && quietLeft > 0) {
            // Respect Break Room cool-down — hopping during it triggers longer slow-downs
            setStatus(
              "waiting",
              `Break Room cool-down ${Math.ceil(quietLeft / 1000)}s — then grab list stock`,
              { currentUrl: page.url(), scene },
            );
            await sleep(Math.min(5000, quietLeft));
            continue;
          }

          if (canOpen && target.categoryId != null) {
            const catId = target.categoryId;
            setStatus(
              "waiting",
              `Opening ${target.categoryName || "category"} (#${catId}) intro — hunt REVIEW CALLS`,
              { currentUrl: page.url(), scene },
            );
            lastQueueNavAt = Date.now();
            // Prefer direct intro — Category List thrash with soft-assist/practice
            const landed = await huntReviewCalls(page, catId);
            if (landed === "review") {
              emptyStreak = 0;
              recordQueueOutcome(catId, "hit");
              continue;
            }
            if (landed === "practice") {
              await maybeCompletePractice(catId);
              continue;
            }
            if (landed === "empty") {
              recordQueueOutcome(catId, "empty");
              await applyRecovery(catId, scene);
              continue;
            }
            // Fallback: list REVIEW click only if intro hunt cannot place us
            const result = await openCategoryViaReviewClick(page, catId);

            if (result === "login") {
              recordQueueOutcome(catId, "login_bounce");
              setStatus("waiting", "REVIEW click bounced to login — re-auth", {
                currentUrl: page.url(),
                scene,
              });
              await ensureLogin(page);
              await sleep(10000);
              const clock = getEstClock();
              nextCooldownMs = cooldownForWindow(classifyTrafficWindow(clock.hour, clock.weekday));
              continue;
            }
            if (result === "empty" || result === "missing") {
              recordQueueOutcome(catId, result === "missing" ? "missing" : "empty");
              await applyRecovery(catId, scene);
            continue;
            }
            if (result === "practice" || result === "ready") {
              emptyStreak = 0;
              lastQueueNavAt = Date.now();
              nextCooldownMs = 20000;
              if (await hasCallAudio(page) || (await isLiveReviewScreen(page))) {
                const held = await holdAndReviewCall(page, target.practiceMode);
                if (held === "ok") recordQueueOutcome(catId, "hit");
                continue;
              }
              // Prefer REVIEW CALLS over practice every time
              if (await hasReviewQueueCta(page)) {
                setStatus("waiting", "Entering live queue via REVIEW CALLS (not practice)", {
                  currentUrl: page.url(),
                  scene,
                });
                await clickReviewCallsCta(page);
                const landed = await afterReviewCallsClick(page);
                if (landed === "empty") {
                  await applyRecovery(catId, scene);
            continue;
                }
                if (landed === "review" || (await hasCallAudio(page))) {
                  recordQueueOutcome(catId, "hit");
                  continue;
                }
              }
              const landed = await detectPageScene(page);
              console.log(formatSceneLog(landed));
              if (landed.action === "hold_call" || landed.action === "review_call" || landed.action === "click_review_calls") {
                if (landed.action === "click_review_calls") {
                  await clickReviewCallsCta(page);
                  await afterReviewCallsClick(page);
                } else {
                  const held = await holdAndReviewCall(page, target.practiceMode);
                  if (held === "ok") recordQueueOutcome(catId, "hit");
                }
                continue;
              }
              // Only do practice if CTA truly missing
              if (landed.action === "complete_practice" && !(await hasReviewQueueCta(page))) {
                await maybeCompletePractice(catId);
                continue;
              }
              const settled = await settleOnCallIntro(page);
              if (settled === "review") continue;
              if (settled === "empty") {
                await applyRecovery(catId, scene);
                continue;
              }
              if (settled === "practice" && !(await hasReviewQueueCta(page))) {
                await maybeCompletePractice(catId);
              }
              continue;
            }
          }

          // Unknown / wrong page — steer back to target intro instead of sitting idle
          if (
            (scene.kind === "unknown" || scene.kind === "profile" || scene.kind === "category_list") &&
            target.categoryId != null &&
            quietLeft <= 0 &&
            Date.now() - lastQueueNavAt >= nextCooldownMs
          ) {
            setStatus(
              "waiting",
              `Wrong/unknown page — returning to #${target.categoryId} intro`,
              { currentUrl: page.url(), scene },
            );
            const intro = `https://www.humanatic.com/pages/humfun/hcat_intro.cfm?hcat=${target.categoryId}&x19=1`;
            await page.goto(intro, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined);
            lastQueueNavAt = Date.now();
            nextCooldownMs = 8000;
            await sleep(1500);
            continue;
          }

          const catLabel =
            target.categoryId != null
              ? `${target.categoryName || "Category"} (#${target.categoryId})`
              : "no category";
          const waitLeft = Math.max(0, nextCooldownMs - (Date.now() - lastQueueNavAt));
          setStatus(
            "waiting",
            `${scene.summary} · ${catLabel}. Next queue try in ~${Math.ceil(waitLeft / 1000)}s`,
            { currentUrl: scene.url, scene },
          );
          await sleep(POLL_MS);
        }
      }
    } catch (e) {
      console.error("[wait] Loop error:", e);
      consecutiveLoopErrors += 1;
      const msg = (e as Error).message || String(e);
      if (isClosedBrowserError(e) || page?.isClosed?.()) {
        // Prefer "waiting" over sticky "error" so dashboard never looks permanently dead
        setStatus("waiting", `Browser closed — recovering (${consecutiveLoopErrors})…`, {
          currentUrl: "",
        });
        try {
          await attachBrowser("recover");
          consecutiveLoopErrors = 0;
          setStatus("waiting", "Chrome recovered — resuming hunt", {
            currentUrl: page.url(),
          });
          await sleep(3000);
          continue;
        } catch (recoverErr) {
          console.error("[wait] Recover failed:", recoverErr);
          setStatus(
            "waiting",
            `Recover retry soon: ${(recoverErr as Error).message}`,
          );
          await sleep(12_000);
          continue;
        }
      }
      try {
        setStatus("waiting", `Recovering: ${msg}`, { currentUrl: page?.url?.() || "" });
      } catch {
        setStatus("waiting", `Recovering: ${msg}`);
      }
      const backoff = Math.min(45_000, 5000 * consecutiveLoopErrors);
      await sleep(backoff);
      if (consecutiveLoopErrors >= 3) {
        console.warn("[wait] Loop errors — full Chrome recover");
        try {
          await attachBrowser("recover");
          consecutiveLoopErrors = 0;
        } catch {
          await sleep(15_000);
        }
      }
    }
  }
}

/** Outer supervisor — never leave a fatal exit while the process is intended to run. */
async function runForever() {
  for (;;) {
    try {
      await main();
      // main() only returns if the while-loop somehow ends — restart
      setStatus("waiting", "Worker loop ended — restarting…");
    } catch (e) {
      console.error("[wait] Fatal (will restart):", e);
      setStatus("waiting", `Restarting after crash: ${(e as Error).message}`);
    }
    await sleep(8000);
  }
}

runForever();
