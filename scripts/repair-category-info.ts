/**
 * Repair pass: re-scrape categories that bounced to login.
 * Clicks (i) / REVIEW from category.cfm (not direct deep-links).
 */
import fs from "fs";
import path from "path";
import { chromium, Page } from "playwright";
import { config } from "../src/config";
import { CATEGORY_LIST_URL, LOGIN_URL } from "../src/categories";
import {
  loginWithCredentials,
  isLoggedIn,
  isSessionReady,
  waitForFaceVerifyClear,
  isOnFaceVerifyPage,
} from "../src/session";
import { navigateWithChallengeHandling } from "../src/verification";

const outDir = path.resolve(process.cwd(), "analysis-output", "categories");
const DEBUG_PORT = config.chromeDebugPort;
const TARGET_IDS = [87, 78, 20]; // Department, Rent Buzz, Dealership — failed last pass

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const humanPause = async (min = 900, max = 2200) =>
  sleep(min + Math.floor(Math.random() * (max - min)));
const safeName = (label: string) => label.replace(/[^\w.-]+/g, "_").slice(0, 60);

async function ensureLogin(page: Page) {
  if (await isSessionReady(page)) return;
  await navigateWithChallengeHandling(page, LOGIN_URL);
  await humanPause(1000, 2000);
  if (!(await isLoggedIn(page))) {
    if (!(await loginWithCredentials(page))) throw new Error("Auto-login failed");
  }
  if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page);
  await humanPause();
}

async function goCategoryList(page: Page) {
  await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await humanPause(1400, 2600);
  if (page.url().includes("login.cfm")) {
    await ensureLogin(page);
    await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await humanPause(1200, 2200);
  }
}

async function extractInstructions(page: Page) {
  return page.evaluate(() => {
    const body = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    if (/log in|forgot your password/i.test(body) && body.length < 200) {
      return { ok: false as const, body, instructions: "", url: location.href, title: document.title };
    }
    const m = body.match(/Category Instructions[:\s]*([\s\S]+?)(?:Helpful information:|$)/i);
    const helpful = body.match(/Helpful information:([\s\S]+?)(?:Submit|Continue|Back to|Category List|$)/i);
    let instructions = "";
    if (m) instructions = `Category Instructions: ${m[1].trim()}`;
    if (helpful) instructions += `\n\nHelpful information:${helpful[1].trim()}`;
    if (!instructions) instructions = body.replace(/^Review\s*/i, "").slice(0, 8000);
    return {
      ok: true as const,
      url: location.href,
      title: document.title,
      instructions: instructions.slice(0, 12000),
      bodyPreview: body.slice(0, 4000),
    };
  });
}

async function clickInfoById(page: Page, categoryId: number): Promise<boolean> {
  const clicked = await page.evaluate((id) => {
    const rows = Array.from(document.querySelectorAll(".category-row"));
    for (const row of rows) {
      const info = row.querySelector(
        `a[href*="hcat=${id}"], a[href*="hcat=${id}&"]`,
      ) as HTMLAnchorElement | null;
      if (!info) continue;
      info.click();
      return true;
    }
    return false;
  }, categoryId);
  return clicked;
}

async function clickReviewById(page: Page, categoryId: number): Promise<boolean> {
  return page.evaluate((id) => {
    const a = document.querySelector(
      `a[href*="category_selector.cfm?category=${id}"]`,
    ) as HTMLAnchorElement | null;
    if (!a) return false;
    a.click();
    return true;
  }, categoryId);
}

async function main() {
  console.log("[repair] Connecting…");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No context");
  const page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());

  await ensureLogin(page);
  await goCategoryList(page);

  const allPath = path.join(outDir, "ALL_CATEGORIES.json");
  const all: Array<Record<string, unknown>> = fs.existsSync(allPath)
    ? JSON.parse(fs.readFileSync(allPath, "utf8"))
    : [];

  for (const id of TARGET_IDS) {
    const existing = all.find((r) => r.categoryId === id);
    const name = String(existing?.name || `category-${id}`);
    console.log(`\n[repair] === [${id}] ${name} ===`);

    await goCategoryList(page);
    await humanPause(800, 1500);

    const clicked = await clickInfoById(page, id);
    if (!clicked) {
      console.warn(`[repair] No (i) link for ${id}`);
      continue;
    }

    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await humanPause(1600, 3000);
    if (isOnFaceVerifyPage(page)) {
      await waitForFaceVerifyClear(page, 180000);
      await humanPause();
    }

    // If still on list (SPA?), try waiting
    if (page.url().includes("category.cfm")) {
      await humanPause(1000, 2000);
    }

    let detail = await extractInstructions(page);
    if (!detail.ok || page.url().includes("login.cfm")) {
      console.warn(`[repair] Bounce/login on info for ${id} — re-login and retry once`);
      await ensureLogin(page);
      await goCategoryList(page);
      await humanPause(1500, 2500);
      await clickInfoById(page, id);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await humanPause(2000, 3500);
      detail = await extractInstructions(page);
    }

    console.log(
      `[repair] Instructions ok=${detail.ok} chars=${detail.instructions?.length ?? 0} url=${page.url()}`,
    );

    const fileBase = `${id}-${safeName(name)}-instructions`;
    fs.writeFileSync(path.join(outDir, `${fileBase}.json`), JSON.stringify(detail, null, 2));
    await page.screenshot({ path: path.join(outDir, `${fileBase}.png`), fullPage: true }).catch(() => undefined);

    let review: unknown = existing?.review ?? null;
    // Department (87) had review available — open via list click only
    if (id === 87 && existing?.canReview) {
      await goCategoryList(page);
      await humanPause(1200, 2200);
      const opened = await clickReviewById(page, id);
      if (opened) {
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await humanPause(2000, 3500);
        if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page, 180000);
        if (page.url().includes("login.cfm")) {
          console.warn("[repair] REVIEW bounced to login — skip queue");
        } else {
          review = await page.evaluate(() => {
            const radios = Array.from(
              document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
            ).map((r, i) => ({
              id: r.id || `opt-${i}`,
              name: r.name,
              value: r.value,
              label:
                (r.id &&
                  document.querySelector(`label[for='${CSS.escape(r.id)}']`)?.textContent?.trim()) ||
                r.closest("label")?.textContent?.trim() ||
                r.value,
            }));
            return {
              url: location.href,
              title: document.title,
              body: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 6000),
              radios,
              radioCount: radios.length,
              isNoCalls:
                /nocalls\.cfm/i.test(location.href) || /no calls/i.test(document.body?.innerText || ""),
            };
          });
          fs.writeFileSync(
            path.join(outDir, `${id}-${safeName(name)}-queue.json`),
            JSON.stringify(review, null, 2),
          );
          await page.screenshot({
            path: path.join(outDir, `${id}-${safeName(name)}-queue.png`),
            fullPage: true,
          }).catch(() => undefined);
          console.log(
            `[repair] Queue radios=${(review as { radioCount?: number }).radioCount} url=${(review as { url?: string }).url}`,
          );
        }
      }
    }

    if (existing) {
      existing.instructions = detail.instructions || existing.instructions;
      existing.instructionsMeta = { url: detail.url, title: detail.title, ok: detail.ok };
      existing.review = review;
      existing.scraped_at = new Date().toISOString();
      existing.repaired = true;
    }

    fs.writeFileSync(allPath, JSON.stringify(all, null, 2));
    await humanPause(1500, 2800);
  }

  const summary = all.map((r) => ({
    id: r.categoryId,
    name: r.name,
    status: r.status,
    calls: r.availableCalls,
    payout: r.payout,
    instructionsChars: String(r.instructions || "").length,
    queueRadios: (r.review as { radioCount?: number } | null)?.radioCount ?? null,
    instructionsOk: !/^Welcome to Humanatic/i.test(String(r.instructions || "")),
  }));
  fs.writeFileSync(path.join(outDir, "SUMMARY.json"), JSON.stringify(summary, null, 2));
  console.log("\n[repair] Done. Summary:");
  summary.forEach((s) =>
    console.log(
      `  [${s.id}] ${s.name} | ok=${s.instructionsOk} instr=${s.instructionsChars} radios=${s.queueRadios ?? "-"}`,
    ),
  );

  await goCategoryList(page);
}

main().catch((e) => {
  console.error("[repair] Fatal:", e);
  process.exit(1);
});
