/**
 * Enter the live review queue from a category intro (hcat_intro).
 *
 * Humanatic's "REVIEW CALLS" control is often an <a href="…/x19/category_selector.cfm?category=N">
 * with nested .category-review-btn-text — Playwright getByText / generic button scrapes miss it.
 */
import { Page } from "playwright";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function hasReviewQueueCta(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    if (document.querySelector('a[href*="category_selector.cfm"]')) return true;
    if (document.querySelector(".category-review-btn, .category-review-btn-text")) return true;
    const nodes = Array.from(
      document.querySelectorAll("a, button, input[type='button'], input[type='submit'], [role='button'], span"),
    );
    return nodes.some((el) => {
      const t = ((el as HTMLElement).innerText || (el as HTMLInputElement).value || "").replace(/\s+/g, " ");
      return /review\s+calls/i.test(t);
    });
  }).catch(() => false);
}

/**
 * Click the on-page REVIEW CALLS / category_selector CTA.
 * Returns true if a click was attempted.
 */
export async function clickReviewCallsCta(page: Page): Promise<boolean> {
  // Preferred: the real queue link Humanatic puts on hcat_intro
  const byHref = page.locator('a[href*="category_selector.cfm"]').first();
  if ((await byHref.count().catch(() => 0)) > 0) {
    await byHref.scrollIntoViewIfNeeded().catch(() => undefined);
    await sleep(300);
    await byHref.click({ timeout: 8000 }).catch(async () => {
      // Nested click target
      await page.locator(".category-review-btn, .category-review-btn-text").first().click({ timeout: 5000 });
    });
    return true;
  }

  const byClass = page.locator(".category-review-btn, .category-review-btn-text").first();
  if ((await byClass.count().catch(() => 0)) > 0) {
    await byClass.scrollIntoViewIfNeeded().catch(() => undefined);
    await byClass.click({ timeout: 8000 }).catch(() => undefined);
    return true;
  }

  const byText = page.getByText(/REVIEW\s+CALLS/i).first();
  if (await byText.isVisible().catch(() => false)) {
    await byText.click({ timeout: 8000 }).catch(() => undefined);
    return true;
  }

  // Last resort: evaluate click on selector link
  const clicked = await page.evaluate(() => {
    const a =
      (document.querySelector('a[href*="category_selector.cfm"]') as HTMLAnchorElement | null) ||
      (document.querySelector(".category-review-btn")?.closest("a") as HTMLAnchorElement | null);
    if (!a) return false;
    a.scrollIntoView({ block: "center" });
    a.click();
    return true;
  }).catch(() => false);

  return clicked;
}

/** After CTA click: wait briefly for navigation / live UI. */
export async function afterReviewCallsClick(page: Page): Promise<"review" | "empty" | "practice" | "intro" | "other"> {
  await sleep(2500);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await sleep(1200);
  const u = page.url().toLowerCase();
  if (u.includes("nocalls.cfm")) return "empty";
  if (u.includes("login.cfm") || u.includes("logout.cfm")) return "other";
  if (u.includes("break_room")) return "other";
  const practice = await page.locator(".practice-review").count().catch(() => 0);
  if (practice >= 1) return "practice";
  const state = await page.evaluate(() => {
    const radios = document.querySelectorAll('input[type="radio"]').length;
    const audio = !!document.querySelector("audio");
    const practiceBlocks = document.querySelectorAll(".practice-review").length;
    if (practiceBlocks >= 1) return "practice" as const;
    if (radios >= 2) return "review" as const;
    if (audio) return "review" as const; // options may still be loading — caller must hold
    return "other" as const;
  }).catch(() => "other" as const);
  if (state === "review" || state === "practice") return state;
  if (u.includes("hcat_intro") || u.includes("category_selector") || /\/x19\//i.test(u)) return "intro";
  return "other";
}
