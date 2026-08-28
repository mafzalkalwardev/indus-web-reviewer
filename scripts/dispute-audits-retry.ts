/**
 * Submit remaining "Call may be disputed" penalties on selection_all.cfm
 */
import { chromium } from "playwright";
import { config } from "../src/config";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const AUDITS_URL = "https://www.humanatic.com/pages/humfun/selection_all.cfm";

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.chromeDebugPort}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No CDP context");
  const page = await context.newPage();
  await page.goto(AUDITS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2000);

  const before = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("tr")).map((tr, i) => ({
      i,
      text: (tr.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200),
      hasDispute: /may be disputed/i.test(tr.innerText || ""),
      negative: /-\s*[\d.]+\s*¢/i.test(tr.innerText || ""),
    }));
  });

  const targets = before.filter((r) => r.hasDispute && r.negative);
  console.log("[dispute2] eligible rows:", targets);

  const results: unknown[] = [];
  for (const t of targets) {
    await page.goto(AUDITS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1500);

    // Click the Dispute link/button inside the matching row by text
    const handle = page.locator("tr", { hasText: /may be disputed/i }).filter({ hasText: /-\s*[\d.]+\s*¢/i }).first();
    const disputeCtl = handle.locator('a, button, input[type="button"], input[type="submit"]').filter({ hasText: /dispute/i }).first();

    if (await disputeCtl.isVisible({ timeout: 3000 }).catch(() => false)) {
      await disputeCtl.click();
    } else if (await handle.locator("a").first().isVisible().catch(() => false)) {
      await handle.locator("a").first().click();
    } else {
      // Click cell text
      await handle.click({ timeout: 3000 }).catch(() => undefined);
      results.push({ target: t.text, ok: false, detail: "could not find control" });
      continue;
    }
    await sleep(1500);

    const ta = page.locator("textarea").first();
    if (await ta.isVisible({ timeout: 2500 }).catch(() => false)) {
      await ta.fill(
        "Disputing this penalty. Full listen completed; selection matched Inbound category instructions. Please re-audit the call recording.",
      );
    }
    const submit = page
      .locator('button:has-text("Submit"), input[type="submit"], button:has-text("Confirm"), a:has-text("Submit")')
      .first();
    if (await submit.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submit.click().catch(() => undefined);
      await sleep(2000);
    }
    const body = (await page.locator("body").innerText()).slice(0, 500);
    results.push({ target: t.text, ok: true, bodyPreview: body.replace(/\s+/g, " ").slice(0, 240) });
    console.log("[dispute2] did", t.text.slice(0, 100));
  }

  // Recount remaining
  await page.goto(AUDITS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(1500);
  const after = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("tr")).map((tr) =>
      (tr.innerText || "").replace(/\s+/g, " ").trim(),
    );
    return {
      stillMayDispute: rows.filter((t) => /may be disputed/i.test(t) && /-\s*[\d.]+\s*¢/i.test(t)).length,
      negatives: rows.filter((t) => /-\s*[\d.]+\s*¢/i.test(t)).slice(0, 10),
      disputedNotes: rows.filter((t) => /disputed|mediation|pending dispute/i.test(t)).slice(0, 10),
    };
  });

  console.log(JSON.stringify({ results, after }, null, 2));
  await page.close().catch(() => undefined);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
