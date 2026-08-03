/**
 * Humanatic Break Room (slow-down / analytics redirect).
 *
 * URL: …/break_room.cfm?categorize_slow_down
 * Flow: wait ~20s → "CONTINUE REVIEWING CALLS" appears → click (no frantic refresh).
 *
 * Scrolling: this account often hides the OS scrollbar. Prefer
 * element.scrollIntoView / mouse.wheel / keyboard — never rely on a visible scroller.
 */
import { Page, Locator } from "playwright";

const BREAK_ROOM_URL_HINT = "break_room.cfm";
const CONTINUE_RE =
  /continue\s+reviewing\s+calls|return\s+to\s+(call\s+)?review|continue\s+review/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const humanPause = async (min = 600, max = 1600) =>
  sleep(min + Math.floor(Math.random() * (max - min)));

export const isOnBreakRoom = (page: Page): boolean => {
  try {
    const url = page.url().toLowerCase();
    return url.includes(BREAK_ROOM_URL_HINT) || url.includes("categorize_slow_down");
  } catch {
    return false;
  }
};

export const looksLikeBreakRoom = async (page: Page): Promise<boolean> => {
  if (isOnBreakRoom(page)) return true;
  try {
    return await page.evaluate(() => {
      const t = (document.body?.innerText || "").toLowerCase();
      return (
        t.includes("welcome to the break room") ||
        (t.includes("break room") && t.includes("please wait")) ||
        t.includes("categorize_slow_down")
      );
    });
  } catch {
    return false;
  }
};

/**
 * Reveal content below the fold when the page hides scrollbars.
 * Works without a visible scrollbar (overflow still scrolls via JS/wheel/keys).
 */
export const revealBelowFold = async (page: Page, target?: Locator): Promise<void> => {
  if (target) {
    await target.evaluate((el) => {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      // Also scroll any overflow ancestors (common when body { overflow:hidden } hides the bar)
      let node: HTMLElement | null = el.parentElement;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        const canScroll =
          /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
        if (canScroll) {
          const rect = el.getBoundingClientRect();
          const parentRect = node.getBoundingClientRect();
          if (rect.bottom > parentRect.bottom - 40 || rect.top < parentRect.top + 40) {
            node.scrollTop += rect.top - parentRect.top - parentRect.height / 3;
          }
        }
        node = node.parentElement;
      }
    });
    await humanPause(400, 900);
    return;
  }

  // Gentle human scroll: wheel + PageDown + End
  await page.mouse.move(400 + Math.random() * 200, 300 + Math.random() * 100);
  await page.mouse.wheel(0, 400 + Math.floor(Math.random() * 300));
  await humanPause(300, 700);
  await page.keyboard.press("PageDown").catch(() => undefined);
  await humanPause(200, 500);
  await page.evaluate(() => {
    window.scrollBy({ top: Math.min(600, document.body.scrollHeight), behavior: "smooth" });
    document.documentElement.scrollTop = document.documentElement.scrollHeight;
    document.body.scrollTop = document.body.scrollHeight;
  });
  await humanPause(400, 800);
};

const continueLocator = (page: Page): Locator =>
  page
    .locator("a, button, input[type='button'], input[type='submit'], [role='button']")
    .filter({ hasText: CONTINUE_RE });

/**
 * If on Break Room: wait for the countdown, reveal CONTINUE, click it.
 * Safe to call anytime — no-ops when not in break room.
 */
export const handleBreakRoomIfPresent = async (
  page: Page,
  timeoutMs = 90000,
): Promise<boolean> => {
  if (!(await looksLikeBreakRoom(page))) return false;

  console.log("[break] Break Room detected — waiting like a human (no refresh spam)…");
  const started = Date.now();

  // Soft presence: read the page, maybe nudge scroll so green tiles / button aren't clipped
  await humanPause(1200, 2200);
  await revealBelowFold(page);

  while (Date.now() - started < timeoutMs) {
    if (!(await looksLikeBreakRoom(page)) && !isOnBreakRoom(page)) {
      console.log("[break] Left Break Room");
      return true;
    }

    const btn = continueLocator(page).first();
    const visible = await btn.isVisible().catch(() => false);
    if (visible) {
      await revealBelowFold(page, btn);
      await humanPause(800, 1600);
      console.log('[break] Clicking "CONTINUE REVIEWING CALLS"…');
      await btn.click({ timeout: 10000 });
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await humanPause(1500, 2800);

      if (await looksLikeBreakRoom(page)) {
        // Button may need a second beat after countdown hits 0
        await humanPause(1500, 2500);
        if (await continueLocator(page).first().isVisible().catch(() => false)) {
          await revealBelowFold(page, continueLocator(page).first());
          await continueLocator(page).first().click({ timeout: 10000 }).catch(() => undefined);
          await humanPause(1200, 2200);
        }
      }

      console.log(`[break] After continue → ${page.url()}`);
      return true;
    }

    // Still counting down — stay put; occasional tiny scroll/look (human fidget)
    if (Math.random() < 0.25) {
      await page.mouse.wheel(0, 80 + Math.floor(Math.random() * 120));
    }
    await sleep(1500 + Math.floor(Math.random() * 1000));
  }

  throw new Error(`Break Room did not offer CONTINUE within ${timeoutMs}ms`);
};

/**
 * Call before/after navigations and between review calls.
 */
export const ensureClearOfBreakRoom = async (page: Page): Promise<void> => {
  await handleBreakRoomIfPresent(page);
};
