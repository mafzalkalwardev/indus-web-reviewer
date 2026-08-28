/**
 * Dispute eligible penalties via selection_review.cfm with Cloudflare handling.
 */
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { config } from "../src/config";
import { navigateWithChallengeHandling } from "../src/verification";
import { loginWithCredentials, isLoggedIn, isOnFaceVerifyPage, waitForFaceVerifyClear } from "../src/session";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "https://www.humanatic.com/pages/humfun/";
const AUDITS = `${BASE}selection_all.cfm`;
const CIDS = ["6001652304339", "6001652230459"];

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.chromeDebugPort}`);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  await navigateWithChallengeHandling(page, `${BASE}profile.cfm`);
  await sleep(1000);
  if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page, 90000);
  if (!(await isLoggedIn(page))) {
    await loginWithCredentials(page);
    await sleep(1500);
  }

  const results: unknown[] = [];

  for (const cid of CIDS) {
    const url = `${BASE}selection_review.cfm?cid=${cid}`;
    console.log("[dispute] opening", url);
    await navigateWithChallengeHandling(page, url);
    await sleep(2000);

    if (/login\.cfm/i.test(page.url())) {
      await loginWithCredentials(page);
      await sleep(1500);
      await navigateWithChallengeHandling(page, url);
      await sleep(2000);
    }

    const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    const snap = {
      cid,
      url: page.url(),
      title: await page.title(),
      preview: body.slice(0, 600),
      hasDispute: /dispute/i.test(body),
      hasAudio: /audio|play|recording/i.test(body),
    };
    console.log("[dispute] landed", snap.url, "dispute?", snap.hasDispute);

    // Prefer an explicit Dispute action
    const disputeBtn = page
      .locator('a:has-text("Dispute"), button:has-text("Dispute"), input[value*="Dispute" i]')
      .first();
    if (await disputeBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await disputeBtn.click();
      await sleep(1500);
    }

    const ta = page.locator("textarea").first();
    if (await ta.isVisible({ timeout: 3000 }).catch(() => false)) {
      await ta.fill(
        "Disputing this Inbound penalty. I fully listened to the call recording and selected based on category instructions. Please re-audit — the chosen option matched the call content.",
      );
    }

    // Common submit controls on dispute form
    const submit = page
      .locator(
        [
          'input[type="submit"]',
          'button:has-text("Submit")',
          'button:has-text("Submit Dispute")',
          'button:has-text("Confirm")',
          'a:has-text("Submit")',
          'input[value*="Submit" i]',
        ].join(", "),
      )
      .first();
    if (await submit.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submit.click().catch(() => undefined);
      await sleep(2500);
    }

    // Checkbox agreement then submit
    const boxes = page.locator('input[type="checkbox"]');
    const boxCount = await boxes.count();
    for (let i = 0; i < boxCount; i++) {
      await boxes.nth(i).check().catch(() => undefined);
    }
    if (await submit.isVisible({ timeout: 1500 }).catch(() => false)) {
      await submit.click().catch(() => undefined);
      await sleep(2000);
    }

    const afterBody = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    results.push({
      ...snap,
      finalUrl: page.url(),
      afterPreview: afterBody.slice(0, 500),
      successHint: /thank|submitted|mediation|dispute.*(received|pending|sent)/i.test(afterBody),
    });
  }

  await navigateWithChallengeHandling(page, AUDITS);
  await sleep(2000);
  const listing = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("tr")).map((tr) =>
      (tr.innerText || "").replace(/\s+/g, " ").trim(),
    );
    return {
      negatives: rows.filter((t) => /-\s*[\d.]+\s*¢/i.test(t)),
      mayDispute: rows.filter((t) => /may be disputed/i.test(t)),
      disputed: rows.filter((t) => /disputed|mediation|awaiting mediation/i.test(t)).slice(0, 8),
    };
  });

  const out = { scrapedAt: new Date().toISOString(), results, listing };
  fs.writeFileSync(path.resolve(process.cwd(), "data", "audits-dispute-final.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await page.close().catch(() => undefined);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
