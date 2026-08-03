/**
 * Practice run on Inbound (category 3):
 * - human-like open from Category List
 * - Grok decides + selects radio
 * - NEVER submits (PRACTICE_MODE)
 * - 1 call only, then leave
 */
import { chromium } from "playwright";
import { config } from "../src/config";
import { CATEGORY_LIST_URL, LOGIN_URL, categoryQueueUrl } from "../src/categories";
import {
  loginWithCredentials,
  isLoggedIn,
  isSessionReady,
  waitForFaceVerifyClear,
  isOnFaceVerifyPage,
} from "../src/session";
import { navigateWithChallengeHandling } from "../src/verification";
import { ReviewEngine } from "../src/stateMachine";
import { discoverReviewSelectors } from "../src/domDiscovery";
import { ensureClearOfBreakRoom } from "../src/breakRoom";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const humanPause = async (min = 900, max = 2200) =>
  sleep(min + Math.floor(Math.random() * (max - min)));

async function ensureLogin(page: import("playwright").Page) {
  if (await isSessionReady(page)) return;
  await navigateWithChallengeHandling(page, LOGIN_URL);
  await humanPause();
  if (!(await isLoggedIn(page))) {
    if (!(await loginWithCredentials(page))) throw new Error("Auto-login failed");
  }
  if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page);
}

async function main() {
  if (!config.practiceMode) {
    throw new Error("PRACTICE_MODE is off. Refusing to run practice script without it.");
  }
  // Cap to 1 call for first practice
  (config as { maxReviewCalls: number }).maxReviewCalls = 1;

  console.log("[practice] Connecting… PRACTICE_MODE=on (no live submit)");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.chromeDebugPort}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No Chrome context");
  const page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());

  await ensureLogin(page);
  await humanPause(1000, 1800);
  await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await humanPause(1500, 2800);

  // Prefer clicking REVIEW on Inbound from the list (session-safe)
  const clicked = await page.evaluate(() => {
    const a = document.querySelector(
      'a[href*="category_selector.cfm?category=3"]',
    ) as HTMLAnchorElement | null;
    if (!a) return false;
    a.click();
    return true;
  });

  if (!clicked) {
    console.warn("[practice] Inbound REVIEW not on list — trying queue URL after list visit");
    await humanPause(1200, 2000);
    await page.goto(categoryQueueUrl(3), { waitUntil: "domcontentloaded", timeout: 60000 });
  }

  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await humanPause(2000, 3500);
  if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page, 180000);

  if (page.url().includes("login.cfm")) {
    await ensureLogin(page);
    await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await humanPause();
    await page.locator('a[href*="category_selector.cfm?category=3"]').click();
    await humanPause(2000, 3500);
  }

  if (/nocalls\.cfm/i.test(page.url())) {
    console.log("[practice] Inbound queue empty (noCalls). Nothing to practice.");
    return;
  }

  await ensureClearOfBreakRoom(page);

  console.log("[practice] Page:", page.url());
  const discovery = await discoverReviewSelectors(page);
  console.log("[practice] Review UI found:", discovery.reviewUiFound);

  if (!discovery.reviewUiFound) {
    throw new Error("Review UI not found — cannot practice");
  }

  const engine = new ReviewEngine(page);
  const summary = await engine.run();
  console.log("[practice] Done (no submit). Summary:", JSON.stringify(summary, null, 2));

  // Leave queue calmly
  await humanPause(1200, 2200);
  await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  console.log("[practice] Returned to Category List.");
}

main().catch((e) => {
  console.error("[practice] Fatal:", e);
  process.exit(1);
});
