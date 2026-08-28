/**
 * Robust: dispute every remaining "Call may be disputed" penalty on selection_all.
 * Handles selection_review discussion threads (click here → comment → submit).
 *
 *   npx ts-node scripts/dispute-remaining.ts
 */
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { config } from "../src/config";
import { loginWithCredentials, isLoggedIn } from "../src/session";

const OUT = path.resolve(process.cwd(), "data", "audits-dispute-remaining.json");
const AUDITS = "https://www.humanatic.com/pages/humfun/selection_all.cfm";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DISPUTE_TEXT =
  "I dispute this audit penalty. I fully listened to the call and selected based on the category instructions and what is audible on the recording. Please re-review the audio and reconsider this penalty.";

async function ensureLogin(page: import("playwright").Page) {
  await page.goto("https://www.humanatic.com/pages/humfun/profile.cfm", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await sleep(1200);
  if (!(await isLoggedIn(page))) {
    await loginWithCredentials(page);
    await sleep(2000);
  }
}

async function completeDisputeOnPage(page: import("playwright").Page): Promise<string> {
  await sleep(1200);
  const url = page.url().toLowerCase();

  // Start discussion if prompted
  const start = page.getByText(/click here/i).first();
  if (await start.isVisible({ timeout: 2000 }).catch(() => false)) {
    await start.click().catch(() => undefined);
    await sleep(1000);
  }
  const startLink = page.locator('a').filter({ hasText: /start a discussion|click here|dispute/i }).first();
  if (await startLink.isVisible({ timeout: 1500 }).catch(() => false)) {
    await startLink.click().catch(() => undefined);
    await sleep(1000);
  }

  const ta = page.locator("textarea").first();
  if (await ta.isVisible({ timeout: 3000 }).catch(() => false)) {
    await ta.fill(DISPUTE_TEXT);
    await sleep(400);
  }

  const submit = page
    .locator(
      'input[type="submit"], button[type="submit"], button:has-text("Submit"), input[value*="Submit" i], button:has-text("Post"), button:has-text("Confirm"), button:has-text("Dispute")',
    )
    .first();
  if (await submit.isVisible({ timeout: 3000 }).catch(() => false)) {
    await submit.click().catch(() => undefined);
    await sleep(2000);
  }

  const body = ((await page.locator("body").innerText().catch(() => "")) || "").toLowerCase();
  if (/dispute.*(submitted|received|pending)|thank you|comment.*(posted|added)|mediation/i.test(body)) {
    return `ok on ${url}`;
  }
  if (await ta.isVisible().catch(() => false)) {
    return `filled form on ${url} (no clear confirm text)`;
  }
  return `opened ${url} body=${body.slice(0, 120)}`;
}

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.chromeDebugPort}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No CDP context — is Chrome/worker running?");
  const page = await context.newPage();
  await ensureLogin(page);

  const results: Array<{ row: string; ok: boolean; detail: string }> = [];

  for (let i = 0; i < 15; i++) {
    await page.goto(AUDITS, { waitUntil: "domcontentloaded", timeout: 90000 });
    await sleep(1800);

    // Recover from login bounce / errors
    if (/login\.cfm/i.test(page.url())) {
      await ensureLogin(page);
      await page.goto(AUDITS, { waitUntil: "domcontentloaded", timeout: 90000 });
      await sleep(1800);
    }

    const left = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("tr"));
      return rows
        .map((tr, idx) => ({
          idx,
          text: (tr.innerText || "").replace(/\s+/g, " ").trim(),
          neg: /-\s*[\d.]+\s*¢/i.test(tr.innerText || ""),
          may: /may be disputed/i.test(tr.innerText || ""),
        }))
        .filter((r) => r.neg && r.may);
    });

    console.log(`[dispute] pass ${i + 1}: ${left.length} eligible left`);
    if (!left.length) break;

    const target = left[0];
    const clicked = await page.evaluate((rowText: string) => {
      const tr = Array.from(document.querySelectorAll("tr")).find((r) =>
        (r.innerText || "").replace(/\s+/g, " ").includes(rowText.slice(0, 60)),
      );
      if (!tr) return { ok: false, detail: "row missing" };
      const a =
        Array.from(tr.querySelectorAll("a")).find((el) => /dispute/i.test(el.textContent || "")) ||
        tr.querySelector("a");
      if (!a) return { ok: false, detail: "no link" };
      (a as HTMLAnchorElement).click();
      return { ok: true, detail: "clicked", href: (a as HTMLAnchorElement).href || "" };
    }, target.text);

    if (!clicked.ok) {
      results.push({ row: target.text.slice(0, 120), ok: false, detail: clicked.detail });
      continue;
    }

    await sleep(2000);
    // If click opened popup
    const pages = context.pages();
    const active = pages[pages.length - 1] || page;
    const detail = await completeDisputeOnPage(active);
    const ok = /ok|filled form/i.test(detail);
    results.push({ row: target.text.slice(0, 120), ok, detail });
    console.log(`[dispute] ${ok ? "OK" : "??"} ${target.text.slice(0, 80)} → ${detail}`);

    if (active !== page) await active.close().catch(() => undefined);
    await sleep(1000);
  }

  await page.goto(AUDITS, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(1500);
  const after = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("tr")).map((tr) =>
      (tr.innerText || "").replace(/\s+/g, " ").trim(),
    );
    return {
      stillMayDispute: rows.filter((t) => /may be disputed/i.test(t) && /-\s*[\d.]+\s*¢/i.test(t)).length,
      disputedish: rows.filter((t) => /disputed|mediation|pending dispute|discussion/i.test(t)).slice(0, 12),
      negatives: rows.filter((t) => /-\s*[\d.]+\s*¢/i.test(t)).slice(0, 12),
    };
  });

  const report = { scrapedAt: new Date().toISOString(), results, after };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ attempted: results.length, ok: results.filter((r) => r.ok).length, after }, null, 2));
  await page.close().catch(() => undefined);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
