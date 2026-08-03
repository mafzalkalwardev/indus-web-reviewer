/**
 * One-shot repair for Department (87) — click from category list.
 */
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.chromeDebugPort}`);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("No context");
  const page = ctx.pages().find((p) => !p.isClosed()) || (await ctx.newPage());

  if (!(await isSessionReady(page))) {
    await navigateWithChallengeHandling(page, LOGIN_URL);
    if (!(await isLoggedIn(page))) await loginWithCredentials(page);
    if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page);
  }

  await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2500);
  await page.waitForSelector(".category-row", { timeout: 15000 });

  const rowInfo = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".category-row")).map((row) => {
      const name = (row.querySelector("sortable")?.textContent || "").trim();
      const info =
        (row.querySelector('a[href*="hcat_intro"]') as HTMLAnchorElement | null)?.href || null;
      const review =
        (row.querySelector('a[href*="category_selector"]') as HTMLAnchorElement | null)?.href ||
        null;
      return { name, info, review };
    }),
  );
  console.log("[dept] rows", JSON.stringify(rowInfo, null, 2));

  const dept = rowInfo.find((r) => /department/i.test(r.name));
  if (!dept?.info) throw new Error("Department info link missing");

  console.log("[dept] opening", dept.info);
  await sleep(1500);
  await page.goto(dept.info, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2500);
  if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page);

  if (page.url().includes("login.cfm")) {
    console.log("[dept] bounced — re-login then list click");
    await loginWithCredentials(page);
    if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page);
    await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(2500);
    await page
      .locator(".category-row", { hasText: "Department" })
      .locator('a[href*="hcat_intro"]')
      .click();
    await page.waitForLoadState("domcontentloaded");
    await sleep(2500);
  }

  const detail = await page.evaluate(() => {
    const body = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    return { url: location.href, title: document.title, body: body.slice(0, 8000) };
  });
  console.log("[dept] url", detail.url);
  console.log("[dept] body", detail.body.slice(0, 350));

  fs.writeFileSync(path.join(outDir, "87-Department-instructions.json"), JSON.stringify(detail, null, 2));
  await page.screenshot({ path: path.join(outDir, "87-Department-instructions.png"), fullPage: true });

  let review: Record<string, unknown> | null = null;
  await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2200);
  const canReview = await page
    .locator(".category-row", { hasText: "Department" })
    .locator('a[href*="category_selector"]')
    .count();

  if (canReview) {
    console.log("[dept] opening REVIEW…");
    await sleep(1500);
    await page
      .locator(".category-row", { hasText: "Department" })
      .locator('a[href*="category_selector"]')
      .click();
    await page.waitForLoadState("domcontentloaded");
    await sleep(2800);
    if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page);
    if (!page.url().includes("login.cfm")) {
      review = await page.evaluate(() => {
        const radios = Array.from(document.querySelectorAll('input[type="radio"]')).map((r, i) => {
          const input = r as HTMLInputElement;
          return {
            id: input.id || `opt-${i}`,
            name: input.name,
            value: input.value,
            label:
              (input.id &&
                document.querySelector(`label[for='${CSS.escape(input.id)}']`)?.textContent?.trim()) ||
              input.closest("label")?.textContent?.trim() ||
              input.value,
          };
        });
        return {
          url: location.href,
          title: document.title,
          radios,
          radioCount: radios.length,
          body: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 6000),
          isNoCalls:
            /nocalls\.cfm/i.test(location.href) || /no calls/i.test(document.body?.innerText || ""),
        };
      });
      fs.writeFileSync(path.join(outDir, "87-Department-queue.json"), JSON.stringify(review, null, 2));
      await page.screenshot({ path: path.join(outDir, "87-Department-queue.png"), fullPage: true });
      console.log("[dept] queue", review.url, "radios", review.radioCount);
    } else {
      console.warn("[dept] REVIEW bounced to login");
    }
  } else {
    console.log("[dept] REVIEW not available right now");
  }

  const allPath = path.join(outDir, "ALL_CATEGORIES.json");
  const all = JSON.parse(fs.readFileSync(allPath, "utf8")) as Array<Record<string, unknown>>;
  const row = all.find((r) => r.categoryId === 87);
  if (row) {
    row.instructions = detail.body;
    row.instructionsMeta = {
      url: detail.url,
      title: detail.title,
      ok: !/log in/i.test(detail.body),
    };
    if (review) row.review = review;
    row.scraped_at = new Date().toISOString();
    row.repaired = true;
  }
  fs.writeFileSync(allPath, JSON.stringify(all, null, 2));

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

  await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  console.log("[dept] done");
  summary.forEach((s) =>
    console.log(
      `  [${s.id}] ${s.name} | ok=${s.instructionsOk} instr=${s.instructionsChars} radios=${s.queueRadios ?? "-"}`,
    ),
  );
}

main().catch((e) => {
  console.error("[dept] Fatal:", e);
  process.exit(1);
});
