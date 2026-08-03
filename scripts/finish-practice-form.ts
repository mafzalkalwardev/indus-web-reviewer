import { chromium } from "playwright";
import { config } from "../src/config";

(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.chromeDebugPort}`);
  const page = browser.contexts()[0]!.pages().find((p) => !p.isClosed())!;
  console.log("url", page.url());

  const state = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll(".practice-review")).map((b, i) => {
      const nice = b.querySelector(".hum-101-review-buttons") as HTMLElement | null;
      const style = nice ? getComputedStyle(nice) : null;
      return {
        i,
        niceDisplay: style?.display,
        checked: (b.querySelector("input[type=radio]:checked") as HTMLInputElement | null)?.id,
        msg: (b.querySelector(".hum-101-review-message") as HTMLElement | null)?.innerText?.slice(0, 100),
      };
    });
    const sub = document.querySelector("input.subbutton") as HTMLInputElement | null;
    return { blocks, subDisabled: sub?.disabled, hasPractice: blocks.length };
  });
  console.log(JSON.stringify(state, null, 2));

  if (!state.hasPractice) {
    console.log("Not on practice page anymore");
    return;
  }

  const fixed = await page.evaluate(() => {
    const results: string[] = [];
    document.querySelectorAll(".practice-review").forEach((block, idx) => {
      const section = (block.querySelector(".hum-101-review-section") || block) as HTMLElement;
      const correct = (section.querySelector("input.hco") as HTMLInputElement | null)?.value || "";
      for (const opt of Array.from(section.querySelectorAll(".option"))) {
        const hco = (opt.querySelector(".the-hco")?.textContent || "").trim();
        if (hco !== correct) continue;
        const input = opt.querySelector("input[type=radio]") as HTMLInputElement;
        input.checked = true;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.click();
        section.querySelector(".submit-button")?.classList.remove("not-active");
        const btn = section.querySelector(".submit-button, .submit-review") as HTMLElement | null;
        btn?.click();
        results.push(`q${idx + 1}=${input.id}`);
        break;
      }
    });
    return results;
  });
  console.log("resubmitted", fixed);
  await page.waitForTimeout(2500);

  await page.evaluate(() => {
    document.querySelectorAll(".hum-101-review-buttons").forEach((el) => {
      (el as HTMLElement).style.display = "block";
    });
    const sub = document.querySelector("input.subbutton") as HTMLInputElement | null;
    if (sub) {
      sub.disabled = false;
      sub.style.background = "#d5541d";
    }
  });

  const initials = page.locator('input[name="initials"]');
  if (await initials.count()) {
    await initials.fill("MAN");
    await page.waitForTimeout(600);
  }
  await page.locator("input.subbutton").click({ timeout: 10000 });
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(2000);
  console.log("after submit →", page.url());
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
