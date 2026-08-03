/**
 * Long-haul live verification:
 * - PRACTICE_MODE must be 0 (real submits)
 * - Rotate across Category List REVIEW links when a queue empties
 * - Human pacing + Break Room handling
 * - Whisper fallback for audio-only calls
 *
 * Usage: npm run long-haul
 * Env: MAX_REVIEW_CALLS, LONG_HAUL_ROUNDS (category rotations before stop)
 */
import { chromium, Page } from "playwright";
import { config } from "../src/config";
import { CATEGORY_LIST_URL, LOGIN_URL, HUMANATIC_CATEGORIES } from "../src/categories";
import {
  loginWithCredentials,
  isLoggedIn,
  isSessionReady,
  waitForFaceVerifyClear,
  isOnFaceVerifyPage,
} from "../src/session";
import { navigateWithChallengeHandling } from "../src/verification";
import { ensureClearOfBreakRoom, revealBelowFold } from "../src/breakRoom";
import { ReviewEngine } from "../src/stateMachine";
import { isQueueEmpty } from "../src/humanatic";
import { discoverReviewSelectors } from "../src/domDiscovery";
import fs from "fs";
import path from "path";

const DEBUG_PORT = config.chromeDebugPort;
const ROUNDS = Number(process.env.LONG_HAUL_ROUNDS || "8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const humanPause = async (min = 1200, max = 2800) =>
  sleep(min + Math.floor(Math.random() * (max - min)));

async function ensureLogin(page: Page) {
  if (await isSessionReady(page)) return;
  await navigateWithChallengeHandling(page, LOGIN_URL);
  await humanPause();
  if (!(await isLoggedIn(page))) {
    if (!(await loginWithCredentials(page))) throw new Error("Auto-login failed");
  }
  if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page);
}

type ListCat = { id: number; name: string; href: string };

async function listReviewableCategories(page: Page): Promise<ListCat[]> {
  await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await humanPause(1500, 2800);
  await ensureClearOfBreakRoom(page);
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll(".category-row"))
      .map((row) => {
        const name = (row.querySelector("sortable")?.textContent || "").trim();
        const a = row.querySelector(
          'a[href*="category_selector"]',
        ) as HTMLAnchorElement | null;
        if (!a || !name) return null;
        const m = a.href.match(/[?&]category=(\d+)/i);
        return { id: m ? Number(m[1]) : 0, name, href: a.href };
      })
      .filter((x): x is ListCat => !!x && x.id > 0);
  });
}

async function safeGoto(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    const msg = (e as Error).message || "";
    if (/ERR_ABORTED|Navigation/i.test(msg)) {
      console.warn(`[haul] Navigation aborted to ${url} — waiting and retrying once`);
      await humanPause(2000, 4000);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => undefined);
    } else {
      throw e;
    }
  }
}

async function openCategoryLive(page: Page, cat: ListCat): Promise<"ready" | "empty" | "practice" | "other"> {
  console.log(`[haul] Opening ${cat.name} (${cat.id})…`);

  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`[haul] ${cat.name} attempt ${attempt}/4`);

    await safeGoto(page, CATEGORY_LIST_URL);
    await humanPause(3000, 5000);
    await ensureClearOfBreakRoom(page);

    if (attempt > 1) {
      console.log(`[haul] Cooling down before retry…`);
      await humanPause(20000, 35000);
    } else {
      // Always cool down a bit — account is Break-Room sensitive
      await humanPause(8000, 14000);
    }

    // Click REVIEW from the list (safer session than raw x19 deep-link)
    const clicked = await page.evaluate((id) => {
      const a = document.querySelector(
        `a[href*="category_selector.cfm?category=${id}"]`,
      ) as HTMLAnchorElement | null;
      if (!a) return false;
      a.click();
      return true;
    }, cat.id);

    if (!clicked) {
      console.warn(`[haul] No REVIEW link for ${cat.id} on list right now`);
      return "empty";
    }

    // Wait for navigation; capture first meaningful URL before TM scripts thrash
    await Promise.race([
      page.waitForURL(/nocalls|hcat_intro|category_selector|break_room|login|logout/i, {
        timeout: 20000,
      }),
      page.waitForTimeout(8000),
    ]).catch(() => undefined);

    await humanPause(1500, 2500);
    let url = page.url();
    console.log(`[haul] First land: ${url}`);

    // Atomic empty detection — Tampermonkey may bounce noCalls → elsewhere
    if (/nocalls\.cfm/i.test(url)) {
      console.log(`[haul] ${cat.name} empty (noCalls)`);
      await humanPause(3000, 5000);
      await safeGoto(page, CATEGORY_LIST_URL);
      return "empty";
    }

    if (/logout\.cfm/i.test(url) || /login\.cfm/i.test(url)) {
      console.warn("[haul] Session bounced — re-login");
      await ensureLogin(page);
      await humanPause(5000, 8000);
      continue;
    }

    if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page, 180000);

    const { looksLikeBreakRoom, handleBreakRoomIfPresent } = await import("../src/breakRoom");
    if (await looksLikeBreakRoom(page)) {
      await handleBreakRoomIfPresent(page);
      console.log(`[haul] Break Room after open — cool down + retry`);
      await humanPause(20000, 35000);
      continue;
    }

    url = page.url();
    if (/nocalls\.cfm/i.test(url)) {
      console.log(`[haul] ${cat.name} empty (noCalls after settle)`);
      return "empty";
    }

    if (url.includes("/category.cfm") && !url.includes("hcat_intro")) {
      console.warn("[haul] Still on category list — retry");
      continue;
    }

    if ((await page.locator(".practice-review").count()) > 0) {
      const rc = page.getByText(/REVIEW CALLS/i).first();
      if (await rc.count()) {
        console.log("[haul] Practice intro — REVIEW CALLS");
        await revealBelowFold(page, rc);
        await humanPause(1000, 1800);
        await rc.click();
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await humanPause(3000, 5000);
        if (/nocalls\.cfm/i.test(page.url())) {
          console.log(`[haul] ${cat.name} empty after REVIEW CALLS`);
          return "empty";
        }
      } else {
        return "practice";
      }
    }

    if (await isQueueEmpty(page)) {
      console.log(`[haul] ${cat.name} empty (queue message)`);
      return "empty";
    }

    const discovery = await discoverReviewSelectors(page);
    if (!discovery.reviewUiFound) {
      console.warn(`[haul] No review UI on ${page.url()} — retry`);
      await humanPause(10000, 15000);
      continue;
    }

    console.log(`[haul] ${cat.name} READY @ ${page.url()}`);
    return "ready";
  }

  console.warn(`[haul] Could not stably open ${cat.name}`);
  return "other";
}

async function main() {
  if (config.practiceMode) {
    throw new Error(
      "PRACTICE_MODE is ON. Set PRACTICE_MODE=0 in .env for live long-haul submits.",
    );
  }

  console.log("=".repeat(60));
  console.log("LONG-HAUL LIVE VERIFICATION");
  console.log(`practiceMode=${config.practiceMode} maxCalls=${config.maxReviewCalls} rounds=${ROUNDS}`);
  console.log(`confidence>=${config.confidenceThreshold} model=${config.grokModel}`);
  console.log("=".repeat(60));

  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  } catch {
    throw new Error(`Chrome CDP ${DEBUG_PORT} not open — launch Chrome with remote debugging first`);
  }

  const context = browser.contexts()[0];
  if (!context) throw new Error("No Chrome context");
  const page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());

  await ensureLogin(page);

  const totals = {
    started_at: new Date().toISOString(),
    submitted: 0,
    skipped: 0,
    attempted: 0,
    categories_tried: [] as string[],
    stop_reason: "",
  };

  let remaining = config.maxReviewCalls;
  let emptyStreak = 0;

  for (let round = 1; round <= ROUNDS && remaining > 0; round++) {
    console.log(`\n[haul] ===== Round ${round}/${ROUNDS} (remaining budget ${remaining}) =====`);
    const cats = await listReviewableCategories(page);
    console.log(`[haul] REVIEW available: ${cats.map((c) => `${c.name}#${c.id}`).join(", ") || "(none)"}`);

    if (!cats.length) {
      emptyStreak += 1;
      console.log(`[haul] No REVIEW categories (streak=${emptyStreak}) — waiting for inventory…`);
      if (emptyStreak >= 5) {
        totals.stop_reason = "all_categories_empty";
        break;
      }
      await humanPause(25000, 45000);
      continue;
    }

    emptyStreak = 0;
    let progressed = false;

    // Try up to 2 categories per round (slow), skip empties
    const focus = cats.slice(0, 2);

    for (const cat of focus) {
      if (remaining <= 0) break;
      totals.categories_tried.push(`${cat.id}:${cat.name}`);

      const gate = await openCategoryLive(page, cat);
      if (gate !== "ready") {
        console.log(`[haul] ${cat.name} gate=${gate} — next`);
        await humanPause(15000, 25000);
        continue;
      }

      // Temporarily cap this engine instance to remaining budget
      const prevMax = config.maxReviewCalls;
      (config as { maxReviewCalls: number }).maxReviewCalls = remaining;

      console.log(`[haul] Engine start on ${cat.name} (budget ${remaining})`);
      const engine = new ReviewEngine(page);
      let summary;
      try {
        summary = await engine.run();
      } catch (e) {
        console.error(`[haul] Engine error on ${cat.name}:`, (e as Error).message);
        await ensureClearOfBreakRoom(page);
        continue;
      } finally {
        (config as { maxReviewCalls: number }).maxReviewCalls = prevMax;
      }

      totals.submitted += summary.reviews_submitted;
      totals.skipped += summary.reviews_skipped;
      totals.attempted += summary.reviews_attempted;
      remaining = Math.max(0, remaining - summary.reviews_attempted);
      progressed = summary.reviews_attempted > 0;

      console.log(
        `[haul] ${cat.name} done: submitted=${summary.reviews_submitted} skipped=${summary.reviews_skipped} stop=${summary.stop_reason}`,
      );

      await humanPause(8000, 14000);
      await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await ensureClearOfBreakRoom(page);
    }

    if (!progressed) {
      emptyStreak += 1;
      if (emptyStreak >= 3) {
        totals.stop_reason = "no_progress";
        break;
      }
      console.log("[haul] No progress this round — waiting before retry…");
      await humanPause(20000, 35000);
    }
  }

  if (!totals.stop_reason) {
    totals.stop_reason = remaining <= 0 ? "max_calls" : "rounds_complete";
  }
  const finished = { ...totals, finished_at: new Date().toISOString(), remaining };

  const out = path.resolve(process.cwd(), "data", "long-haul-summary.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(finished, null, 2));

  // Also print recent review log stats
  const logPath = path.resolve(process.cwd(), "data", "reviews.json");
  if (fs.existsSync(logPath)) {
    const logs = JSON.parse(fs.readFileSync(logPath, "utf8")) as Array<{ status: string; confidence: number }>;
    const recent = logs.slice(-Math.max(totals.attempted, 1));
    const submitted = recent.filter((r) => r.status === "submitted");
    const avgConf =
      submitted.length > 0
        ? submitted.reduce((s, r) => s + (r.confidence || 0), 0) / submitted.length
        : 0;
    console.log("\n[haul] Recent log slice:", {
      entries: recent.length,
      submitted: submitted.length,
      avgConfidence: Number(avgConf.toFixed(3)),
      statuses: recent.reduce((acc: Record<string, number>, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      }, {}),
    });
  }

  console.log("\n[haul] SUMMARY", JSON.stringify(finished, null, 2));
  console.log(`[haul] Saved ${out}`);
}

main().catch((e) => {
  console.error("[haul] Fatal:", e);
  process.exit(1);
});
