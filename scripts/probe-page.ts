/**
 * Attach to running Chrome CDP and dump what Humanatic is showing.
 */
import { chromium } from "playwright";
import { readFileSync } from "fs";
import path from "path";

// Load .env lightly
try {
  const envPath = path.resolve(process.cwd(), ".env");
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {
  /* */
}

async function main() {
  const port = process.env.CHROME_DEBUG_PORT || "9222";
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("No browser context");
  const page =
    ctx.pages().find((p) => !p.isClosed() && /humanatic/i.test(p.url())) ||
    ctx.pages().find((p) => !p.isClosed()) ||
    (await ctx.newPage());

  console.log("URL:", page.url());
  console.log("TITLE:", await page.title().catch(() => "?"));

  const snap = await page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 900);
    const radios = Array.from(document.querySelectorAll('input[type="radio"]')).map((r, i) => {
      const el = r as HTMLInputElement;
      const label = (
        el.closest(".option")?.querySelector(".the-label")?.textContent ||
        el.closest("label")?.textContent ||
        el.value ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      return { i, id: el.id, checked: el.checked, label: label.slice(0, 100) };
    });
    const practice = document.querySelectorAll(".practice-review").length;
    const practiceDone = Array.from(document.querySelectorAll(".practice-review")).filter((b) => {
      const nice = b.querySelector(".hum-101-review-buttons") as HTMLElement | null;
      return !!(nice && getComputedStyle(nice).display !== "none");
    }).length;
    const audios = Array.from(document.querySelectorAll("audio")).map((a) => {
      const el = a as HTMLAudioElement;
      return {
        srcTail: (el.src || "").slice(-50),
        duration: Number.isFinite(el.duration) ? el.duration : null,
        paused: el.paused,
      };
    });
    const submit = Array.from(
      document.querySelectorAll(".submit-button, .submit-review, input.subbutton, input[type=submit]"),
    ).map((el) => ({
      tag: el.tagName,
      cls: String((el as HTMLElement).className || "").slice(0, 80),
      text: ((el as HTMLElement).innerText || (el as HTMLInputElement).value || "").slice(0, 40),
      disabled: !!(el as HTMLInputElement).disabled,
      notActive: el.classList.contains("not-active"),
    }));
    const hco = Array.from(document.querySelectorAll("input.hco")).map(
      (i) => (i as HTMLInputElement).value,
    );
    const initials = !!(document.querySelector('input[name="initials"]'));
    const reviewCalls = /REVIEW\s+CALLS/i.test(document.body?.innerText || "");
    const continueReview = /CONTINUE\s+REVIEWING/i.test(document.body?.innerText || "");
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,.page-title,b"))
      .map((h) => (h.textContent || "").trim())
      .filter((t) => t.length > 2 && t.length < 80)
      .slice(0, 12);
    const url = location.href.toLowerCase();
    return {
      urlHints: {
        login: url.includes("login"),
        face: url.includes("face_verify"),
        breakRoom: url.includes("break_room"),
        categoryList: /\/category\.cfm/i.test(url) && !url.includes("hcat"),
        hcatIntro: url.includes("hcat_intro"),
        categorySelector: url.includes("category_selector"),
        noCalls: url.includes("nocalls"),
        profile: url.includes("profile"),
        hcat: url.match(/[?&]hcat=(\d+)/)?.[1] || null,
      },
      practice,
      practiceDone,
      radioCount: radios.length,
      radios: radios.slice(0, 12),
      audios,
      submit,
      hco,
      initials,
      reviewCalls,
      continueReview,
      headings,
      text,
    };
  });

  console.log(JSON.stringify(snap, null, 2));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
