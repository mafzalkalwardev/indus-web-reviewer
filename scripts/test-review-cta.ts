/**
 * Prove REVIEW CALLS CTA click works on the current hcat_intro tab.
 */
import "dotenv/config";
import { chromium } from "playwright";
import { detectPageScene, formatSceneLog } from "../src/pageScene";
import {
  afterReviewCallsClick,
  clickReviewCallsCta,
  hasReviewQueueCta,
} from "../src/reviewQueue";

async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page =
    browser.contexts()[0].pages().find((p) => !p.isClosed() && /humanatic/i.test(p.url())) ||
    browser.contexts()[0].pages()[0];
  if (!page) throw new Error("no page");

  console.log("URL before:", page.url());
  const before = await detectPageScene(page);
  console.log(formatSceneLog(before));
  console.log("hasCTA:", await hasReviewQueueCta(page));

  if (!(await hasReviewQueueCta(page))) {
    console.error("FAIL: no REVIEW CALLS CTA on page");
    process.exit(1);
  }

  await clickReviewCallsCta(page);
  const landed = await afterReviewCallsClick(page);
  console.log("landed:", landed, page.url());
  const after = await detectPageScene(page);
  console.log(formatSceneLog(after));

  if (landed === "intro" && before.url === page.url()) {
    console.error("FAIL: click did not navigate");
    process.exit(1);
  }
  console.log("PASS: CTA click navigated →", landed);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
