import { chromium } from "playwright";
import { config } from "../src/config";
import { ensureClearOfBreakRoom, revealBelowFold } from "../src/breakRoom";

(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${config.chromeDebugPort}`);
  const page = b.contexts()[0]!.pages().find((x) => !x.isClosed())!;
  console.log("url", page.url());

  // Confirm all Nice! banners visible
  const ok = await page.evaluate(() => {
    const nice = Array.from(document.querySelectorAll(".hum-101-review-buttons"));
    return nice.filter((el) => {
      const s = getComputedStyle(el as HTMLElement);
      return s.display !== "none" && /nice/i.test((el as HTMLElement).innerText);
    }).length;
  });
  console.log("niceCount", ok);

  const reviewCalls = page.getByText(/REVIEW CALLS/i).first();
  if (await reviewCalls.count()) {
    await revealBelowFold(page, reviewCalls);
    await page.waitForTimeout(1000);
    console.log("Clicking REVIEW CALLS…");
    await reviewCalls.click();
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(2500);
    await ensureClearOfBreakRoom(page);
    console.log("now →", page.url());
    const snip = await page.evaluate(() => (document.body?.innerText || "").slice(0, 400));
    console.log(snip);
  } else {
    console.log("REVIEW CALLS not found");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
