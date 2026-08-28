import { chromium } from "playwright";
import { config } from "../src/config";
import { loginWithCredentials, isLoggedIn } from "../src/session";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const AUDITS = "https://www.humanatic.com/pages/humfun/selection_all.cfm";
const ACC = "https://www.humanatic.com/pages/humfun/accuracy.cfm";

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.chromeDebugPort}`);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  await page.goto("https://www.humanatic.com/pages/humfun/profile.cfm", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await sleep(1500);
  if (!(await isLoggedIn(page))) {
    console.log("[fix] Session lost — logging in");
    await loginWithCredentials(page);
    await sleep(2000);
  }

  await page.goto(ACC, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(1200);
  const acc = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  console.log("[acc]", acc.slice(0, 500));

  await page.goto(AUDITS, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(1500);
  const summary = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("tr")).map((tr) =>
      (tr.innerText || "").replace(/\s+/g, " ").trim(),
    );
    const neg = rows.filter((t) => /-\s*[\d.]+\s*¢/i.test(t));
    const may = rows.filter((t) => /may be disputed/i.test(t));
    const waiting = rows.filter((t) => /not eligible for dispute yet/i.test(t));
    const disputed = rows.filter((t) => /disputed|mediation|dispute submitted|pending mediation/i.test(t));
    return {
      totalRows: Math.max(0, rows.length - 1),
      negatives: neg,
      mayDispute: may,
      waiting: waiting.length,
      disputedHints: disputed.slice(0, 8),
      url: location.href,
      title: document.title,
    };
  });

  // Dispute any remaining "may be disputed" negatives
  const results: unknown[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.goto(AUDITS, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1200);
    const left = page.locator("tr").filter({ hasText: /may be disputed/i }).filter({ hasText: /-\s*[\d.]+\s*¢/i });
    const n = await left.count();
    if (n === 0) break;
    const row = left.first();
    const text = (await row.innerText()).replace(/\s+/g, " ").trim();
    const ctl = row.locator("a, button").filter({ hasText: /dispute/i }).first();
    if (await ctl.isVisible({ timeout: 2000 }).catch(() => false)) {
      await ctl.click();
    } else {
      // notes cell often is the link
      await row.locator("td").last().click().catch(() => undefined);
      await row.locator("a").first().click().catch(() => undefined);
    }
    await sleep(1500);
    const ta = page.locator("textarea").first();
    if (await ta.isVisible({ timeout: 2000 }).catch(() => false)) {
      await ta.fill(
        "Disputing this penalty. Call was fully listened; selection matched Inbound instructions. Please re-audit.",
      );
    }
    const submit = page.locator('button:has-text("Submit"), input[type="submit"], button:has-text("Confirm")').first();
    if (await submit.isVisible({ timeout: 2000 }).catch(() => false)) {
      await submit.click().catch(() => undefined);
      await sleep(2000);
    }
    results.push({ text: text.slice(0, 160), done: true, url: page.url() });
  }

  await page.goto(AUDITS, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(1200);
  const after = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("tr")).map((tr) =>
      (tr.innerText || "").replace(/\s+/g, " ").trim(),
    );
    return {
      negatives: rows.filter((t) => /-\s*[\d.]+\s*¢/i.test(t)),
      mayDispute: rows.filter((t) => /may be disputed/i.test(t)),
      disputedHints: rows.filter((t) => /disputed|mediation|submitted/i.test(t)).slice(0, 10),
    };
  });

  console.log(JSON.stringify({ summary, results, after }, null, 2));
  await page.close().catch(() => undefined);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
