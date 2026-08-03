/**
 * Human-like scrape of every category on category.cfm:
 * - read each .category-row (name / calls / payout / status / ids)
 * - open (i) → hcat_intro instructions (no submit)
 * - if REVIEW is available, open queue briefly (no submit) and capture radios
 */
import fs from "fs";
import path from "path";
import { chromium, Page } from "playwright";
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

const outDir = path.resolve(process.cwd(), "analysis-output", "categories");
const DEBUG_PORT = config.chromeDebugPort;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const humanPause = async (min = 800, max = 2200) =>
  sleep(min + Math.floor(Math.random() * (max - min)));

const ensureOut = () => {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
};

const safeName = (label: string) => label.replace(/[^\w.-]+/g, "_").slice(0, 60);

async function ensureLogin(page: Page) {
  if (await isSessionReady(page)) return;
  await navigateWithChallengeHandling(page, LOGIN_URL);
  await humanPause(1000, 2000);
  if (!(await isLoggedIn(page))) {
    const ok = await loginWithCredentials(page);
    if (!ok) throw new Error("Auto-login failed");
  }
  if (isOnFaceVerifyPage(page)) {
    await waitForFaceVerifyClear(page);
  }
  await humanPause();
}

type ListRow = {
  index: number;
  name: string;
  categoryId: number | null;
  availableCalls: string;
  callCount: number;
  payout: string;
  status: "review" | "no_calls" | "unavailable" | "unknown";
  canReview: boolean;
  reviewHref: string | null;
  infoHref: string | null;
};

async function readCategoryRows(page: Page): Promise<ListRow[]> {
  return page.evaluate(() => {
    const rows: ListRow[] = [];
    const els = Array.from(document.querySelectorAll(".category-row"));

    els.forEach((el, index) => {
      const name =
        (el.querySelector("sortable")?.textContent || "").replace(/\s+/g, " ").trim() ||
        (el.querySelector(".category-option-title p")?.textContent || "").replace(/\s+/g, " ").trim();
      if (!name) return;

      const infoA = el.querySelector(
        'a[href*="hcat_intro"], a[href*="hcat="]',
      ) as HTMLAnchorElement | null;
      const reviewA = el.querySelector(
        'a[href*="category_selector"]',
      ) as HTMLAnchorElement | null;

      const infoHref = infoA?.href || null;
      const reviewHref = reviewA?.href || null;

      let categoryId: number | null = null;
      const fromInfo = infoHref?.match(/[?&]hcat=(\d+)/i);
      const fromReview = reviewHref?.match(/[?&]category=(\d+)/i);
      if (fromReview) categoryId = Number(fromReview[1]);
      else if (fromInfo) categoryId = Number(fromInfo[1]);

      const callsText = (el.querySelector(".langName, .calls-available")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      const callMatch = callsText.match(/(\d+)/);
      const callCount = callMatch ? Number(callMatch[1]) : 0;

      const payoutText = (el.querySelector(".category-money")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      const payoutMatch = payoutText.match(/([\d.]+)\s*¢/);

      const statusText = (el.querySelector(".category-text, .category-review-btn-text")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

      let status: ListRow["status"] = "unknown";
      let canReview = false;
      if (reviewHref && /review/i.test(statusText || "review")) {
        canReview = true;
        status = "review";
      } else if (statusText.includes("currently unavailable") || statusText.includes("unavailable")) {
        status = "unavailable";
      } else if (statusText.includes("no calls")) {
        status = "no_calls";
      } else if (el.querySelector(".category-selection-button-locked")) {
        status = callCount === 0 ? "no_calls" : "unavailable";
      }

      rows.push({
        index,
        name,
        categoryId,
        availableCalls: callsText || (callMatch ? `English - ${callCount}` : ""),
        callCount,
        payout: payoutMatch ? `${payoutMatch[1]}¢` : payoutText,
        status,
        canReview,
        reviewHref,
        infoHref,
      });
    });

    return rows;
  });
}

async function scrapeInstructions(page: Page, row: ListRow): Promise<{
  url: string;
  title: string;
  instructions: string;
  bodyPreview: string;
}> {
  const href =
    row.infoHref ||
    (row.categoryId != null
      ? `https://www.humanatic.com/pages/humfun/hcat_intro.cfm?hcat=${row.categoryId}&x19=1`
      : null);

  if (!href) {
    console.warn(`[info] No instructions URL for "${row.name}"`);
    return { url: "", title: "", instructions: "", bodyPreview: "" };
  }

  console.log(`[info] Opening instructions for "${row.name}"…`);
  await humanPause(900, 1800);
  await page.goto(href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await humanPause(1400, 2600);

  if (isOnFaceVerifyPage(page)) {
    await waitForFaceVerifyClear(page, 180000);
    await humanPause();
  }

  const detail = await page.evaluate(() => {
    const body = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    // Prefer text after "Category Instructions"
    const m = body.match(/Category Instructions[:\s]*([\s\S]+?)(?:Helpful information:|$)/i);
    const helpful = body.match(/Helpful information:([\s\S]+?)(?:Submit|Continue|Back to|$)/i);
    let instructions = "";
    if (m) instructions = `Category Instructions: ${m[1].trim()}`;
    if (helpful) instructions += `\n\nHelpful information:${helpful[1].trim()}`;
    if (!instructions) {
      // Strip chrome: take a large useful slice of body
      instructions = body
        .replace(/^Review\s*/i, "")
        .slice(0, 8000);
    }
    return {
      url: location.href,
      title: document.title,
      instructions: instructions.slice(0, 12000),
      bodyPreview: body.slice(0, 4000),
    };
  });

  const fileBase = `${row.categoryId ?? row.index}-${safeName(row.name)}-instructions`;
  fs.writeFileSync(path.join(outDir, `${fileBase}.json`), JSON.stringify(detail, null, 2));
  await page.screenshot({ path: path.join(outDir, `${fileBase}.png`), fullPage: true }).catch(() => undefined);

  await humanPause(1000, 2000);
  await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await humanPause(1000, 2000);
  return detail;
}

async function openReviewBriefly(page: Page, row: ListRow) {
  const href =
    row.reviewHref ||
    (row.categoryId != null ? categoryQueueUrl(row.categoryId) : null);
  if (!href) return null;

  console.log(`[review] Opening queue for "${row.name}" (no submit)…`);
  await humanPause(1200, 2400);
  await page.goto(href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await humanPause(1800, 3200);

  if (isOnFaceVerifyPage(page)) {
    await waitForFaceVerifyClear(page, 180000);
    await humanPause();
  }

  // If bounced to login, stop without forcing
  if (page.url().includes("login.cfm")) {
    console.warn(`[review] Session bounced to login for "${row.name}" — skipping`);
    await ensureLogin(page);
    await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    return { url: "login.cfm", skipped: true };
  }

  const detail = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).map(
      (r, i) => ({
        id: r.id || `opt-${i}`,
        name: r.name,
        value: r.value,
        label:
          (r.id && document.querySelector(`label[for='${CSS.escape(r.id)}']`)?.textContent?.trim()) ||
          r.closest("label")?.textContent?.trim() ||
          r.value,
      }),
    );
    return {
      url: location.href,
      title: document.title,
      body: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 6000),
      radios,
      radioCount: radios.length,
      isNoCalls: /nocalls\.cfm/i.test(location.href) || /no calls/i.test(document.body?.innerText || ""),
    };
  });

  const fileBase = `${row.categoryId ?? row.index}-${safeName(row.name)}-queue`;
  fs.writeFileSync(path.join(outDir, `${fileBase}.json`), JSON.stringify(detail, null, 2));
  await page.screenshot({ path: path.join(outDir, `${fileBase}.png`), fullPage: true }).catch(() => undefined);

  // Leave without submitting — back to list
  await humanPause(1400, 2800);
  await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await humanPause(1000, 2000);
  return detail;
}

async function main() {
  ensureOut();
  console.log("[cats] Connecting to Chrome…");
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  } catch {
    throw new Error(
      `Chrome debug port ${DEBUG_PORT} not open. Start Chrome with remote debugging on your Default profile first.`,
    );
  }

  const context = browser.contexts()[0];
  if (!context) throw new Error("No Chrome context");
  const page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());

  await ensureLogin(page);
  console.log("[cats] Logged in. Opening Category List…");
  await humanPause(800, 1500);
  await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await humanPause(1500, 2800);

  if (page.url().includes("login.cfm")) {
    await ensureLogin(page);
    await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await humanPause();
  }

  await page.screenshot({ path: path.join(outDir, "00-category-list.png"), fullPage: true });
  const rows = await readCategoryRows(page);
  console.log(`[cats] Found ${rows.length} categories on list`);
  rows.forEach((r) =>
    console.log(
      `  - [${r.categoryId ?? "?"}] ${r.name} | ${r.availableCalls} | ${r.payout} | ${r.status}`,
    ),
  );

  if (rows.length !== 6) {
    console.warn(`[cats] Expected 6 categories, got ${rows.length}`);
  }

  const results: unknown[] = [];

  for (const row of rows) {
    console.log(`\n[cats] === [${row.categoryId ?? "?"}] ${row.name} (${row.status}) ===`);
    await humanPause(1000, 2000);

    if (!page.url().includes("category.cfm")) {
      await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await humanPause(1000, 2000);
    }

    const instructions = await scrapeInstructions(page, row);
    console.log(`[cats] Instructions chars: ${instructions.instructions.length}`);

    let reviewDetail: unknown = null;
    if (row.canReview) {
      await humanPause(1500, 3000);
      reviewDetail = await openReviewBriefly(page, row);
      const q = reviewDetail as { radioCount?: number; isNoCalls?: boolean; skipped?: boolean } | null;
      if (q?.skipped) console.log(`[cats] Queue skipped`);
      else if (q?.isNoCalls) console.log(`[cats] Queue empty (noCalls)`);
      else console.log(`[cats] Queue radios: ${q?.radioCount ?? 0}`);
    } else {
      console.log(`[cats] Skipping queue open (${row.status})`);
    }

    results.push({
      ...row,
      instructions: instructions.instructions,
      instructionsMeta: {
        url: instructions.url,
        title: instructions.title,
      },
      review: reviewDetail,
      scraped_at: new Date().toISOString(),
    });

    fs.writeFileSync(path.join(outDir, "ALL_CATEGORIES.json"), JSON.stringify(results, null, 2));
    await humanPause(1400, 2800);
  }

  // Compact summary for humans
  const summary = (results as Array<Record<string, unknown>>).map((r) => ({
    id: r.categoryId,
    name: r.name,
    status: r.status,
    calls: r.availableCalls,
    payout: r.payout,
    instructionsChars: String(r.instructions || "").length,
    queueRadios: (r.review as { radioCount?: number } | null)?.radioCount ?? null,
  }));
  fs.writeFileSync(path.join(outDir, "SUMMARY.json"), JSON.stringify(summary, null, 2));

  console.log(`\n[cats] Done. Saved ${results.length} categories → ${outDir}/ALL_CATEGORIES.json`);
  console.log("[cats] Summary:");
  summary.forEach((s) =>
    console.log(
      `  [${s.id}] ${s.name} | ${s.status} | instr=${s.instructionsChars} | radios=${s.queueRadios ?? "-"}`,
    ),
  );
}

main().catch((e) => {
  console.error("[cats] Fatal:", e);
  process.exit(1);
});
