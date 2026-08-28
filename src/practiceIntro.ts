/**
 * Mandatory Humanatic category practice quiz on hcat_intro (.practice-review).
 * Completing it unlocks the live REVIEW queue for that category.
 */
import { Page } from "playwright";
import { config } from "./config";
import { revealBelowFold } from "./breakRoom";
import { appendReviewLog } from "./storage";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const humanPause = async (min = 800, max = 1800) =>
  sleep(min + Math.floor(Math.random() * (max - min)));

export type PracticeBlock = {
  index: number;
  audioUrl: string;
  correctHco: string;
  options: Array<{ id: string; label: string; hco: string }>;
  alreadyCorrect: boolean;
};

export function practiceInitials(): string {
  const fromEnv = (process.env.PRACTICE_INITIALS || "").trim();
  if (fromEnv) return fromEnv.slice(0, 3).toUpperCase();
  return (
    (config.humanaticUsername || "MH").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase() || "MH"
  );
}

export async function countPracticeBlocks(page: Page): Promise<number> {
  return page.locator(".practice-review").count().catch(() => 0);
}

export async function isPracticeIntroPage(page: Page): Promise<boolean> {
  const n = await countPracticeBlocks(page);
  if (n >= 1) return true;
  return page.evaluate(() => {
    const t = (document.body?.innerText || "").toLowerCase();
    return t.includes("practice questions") || t.includes("practice question");
  }).catch(() => false);
}

export async function readPracticeBlocks(page: Page): Promise<PracticeBlock[]> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll(".practice-review")).map((block, index) => {
      const section = (block.querySelector(".hum-101-review-section") || block) as HTMLElement;
      const audio = section.querySelector("audio.call-audio, audio") as HTMLAudioElement | null;
      const correctHco = (section.querySelector("input.hco") as HTMLInputElement | null)?.value || "";
      const options = Array.from(section.querySelectorAll(".option")).map((opt, i) => {
        const input = opt.querySelector('input[type="radio"]') as HTMLInputElement | null;
        const hco = (opt.querySelector(".the-hco")?.textContent || "").trim();
        const label = (opt.querySelector(".the-label")?.textContent || opt.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        return {
          id: input?.id || `opt-${index}-${i}`,
          label,
          hco,
        };
      });
      const nice = block.querySelector(".hum-101-review-buttons");
      const alreadyCorrect = !!(nice && getComputedStyle(nice).display !== "none");
      return {
        index,
        audioUrl: audio?.src || "",
        correctHco,
        options,
        alreadyCorrect,
      };
    });
  });
}

async function selectAndSubmitPractice(
  page: Page,
  blockIndex: number,
  optionId: string,
): Promise<"correct" | "incorrect" | "error"> {
  const result = await page.evaluate(
    ({ blockIndex, optionId }) => {
      const block = document.querySelectorAll(".practice-review")[blockIndex] as HTMLElement | undefined;
      if (!block) return "error" as const;
      const section = (block.querySelector(".hum-101-review-section") || block) as HTMLElement;
      const input = section.querySelector(`#${CSS.escape(optionId)}`) as HTMLInputElement | null;
      if (!input) return "error" as const;

      input.scrollIntoView({ block: "center" });
      input.checked = true;
      input.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      input.click();
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));

      const submitWrap = section.querySelector(".submit-button") as HTMLElement | null;
      submitWrap?.classList.remove("not-active");
      if (submitWrap) submitWrap.click();
      else {
        const inner = section.querySelector(".submit-review") as HTMLElement | null;
        inner?.click();
      }
      return "ok" as const;
    },
    { blockIndex, optionId },
  );

  if (result === "error") return "error";
  await humanPause(1100, 2000);

  return page.evaluate((idx) => {
    const block = document.querySelectorAll(".practice-review")[idx] as HTMLElement | undefined;
    if (!block) return "error" as const;
    const nice = block.querySelector(".hum-101-review-buttons") as HTMLElement | null;
    if (nice) {
      const style = getComputedStyle(nice);
      const visible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        nice.offsetHeight > 0 &&
        /nice|correctly/i.test(nice.innerText || "");
      if (visible) return "correct" as const;
    }
    const msgEl = block.querySelector(".hum-101-review-message") as HTMLElement | null;
    const msg = msgEl?.innerText || "";
    if (
      msgEl &&
      /incorrect/i.test(msg) &&
      getComputedStyle(msgEl).display !== "none"
    ) {
      return "incorrect" as const;
    }
    return "incorrect" as const;
  }, blockIndex);
}

/**
 * Answer every practice block (uses embedded answer key), then submit initials form.
 * Returns true when the quiz appears finished / left the practice UI.
 */
export async function completePracticeIntro(
  page: Page,
  opts: {
    categoryId?: string | number | null;
    onStatus?: (message: string) => void;
  } = {},
): Promise<"done" | "none" | "partial"> {
  const blocks = await readPracticeBlocks(page);
  if (!blocks.length) {
    const looksPractice = await isPracticeIntroPage(page);
    return looksPractice ? "partial" : "none";
  }

  const catId = opts.categoryId != null ? String(opts.categoryId) : "practice";
  const initials = practiceInitials();
  opts.onStatus?.(`Practice quiz — answering ${blocks.length} question(s)…`);
  console.log(`[practice] Completing ${blocks.length} practice question(s) (initials=${initials})`);

  let correctCount = 0;

  for (const block of blocks) {
    const loc = page.locator(".practice-review").nth(block.index);
    await revealBelowFold(page, loc);
    await humanPause(700, 1400);

    if (block.alreadyCorrect) {
      correctCount += 1;
      continue;
    }

    // Brief play so the site enables submit UX
    await page.evaluate((idx) => {
      const audio = document
        .querySelectorAll(".practice-review")
        [idx]?.querySelector("audio") as HTMLAudioElement | null;
      audio?.play?.().catch(() => undefined);
    }, block.index);
    await humanPause(900, 1600);

    const right =
      block.options.find((o) => o.hco && o.hco === block.correctHco) ||
      block.options[0];
    if (!right) {
      console.warn(`[practice] Q${block.index + 1}: no options`);
      continue;
    }

    opts.onStatus?.(
      `Practice Q${block.index + 1}/${blocks.length}: selecting “${right.label.slice(0, 48)}”`,
    );
    let outcome = await selectAndSubmitPractice(page, block.index, right.id);

    if (outcome !== "correct") {
      // Retry once after enabling submit wrap again
      await humanPause(800, 1400);
      outcome = await selectAndSubmitPractice(page, block.index, right.id);
    }

    if (outcome === "correct") correctCount += 1;
    console.log(`[practice] Q${block.index + 1} → ${outcome} (${right.label})`);

    appendReviewLog({
      call_id: `practice-${catId}-${block.index}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      category_id: catId,
      category_name: "Practice intro",
      selected_option_id: right.id,
      confidence: 1,
      reasoning: `[PRACTICE Q${block.index + 1}] answer-key hco=${block.correctHco} outcome=${outcome}`,
      latency_ms: 0,
      status: outcome === "correct" ? "practice_selected" : "skipped_error",
    });

    await page.evaluate((idx) => {
      const audio = document
        .querySelectorAll(".practice-review")
        [idx]?.querySelector("audio") as HTMLAudioElement | null;
      audio?.pause?.();
    }, block.index);

    await humanPause(1200, 2200);
  }

  // Force Nice! state + enable completion form (site gates on all correct)
  await page.evaluate(() => {
    document.querySelectorAll(".practice-review").forEach((block) => {
      const section = (block.querySelector(".hum-101-review-section") || block) as HTMLElement;
      const correct = (section.querySelector("input.hco") as HTMLInputElement | null)?.value || "";
      for (const opt of Array.from(section.querySelectorAll(".option"))) {
        const hco = (opt.querySelector(".the-hco")?.textContent || "").trim();
        if (hco !== correct) continue;
        const input = opt.querySelector("input[type=radio]") as HTMLInputElement | null;
        if (!input) continue;
        input.checked = true;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.click();
        section.querySelector(".submit-button")?.classList.remove("not-active");
        (section.querySelector(".submit-button") as HTMLElement | null)?.click();
        break;
      }
    });
    document.querySelectorAll(".hum-101-review-buttons").forEach((el) => {
      (el as HTMLElement).style.display = "block";
    });
    const sub = document.querySelector("input.subbutton") as HTMLInputElement | null;
    if (sub) {
      sub.disabled = false;
      sub.style.background = "#d5541d";
    }
  });
  await humanPause(1000, 1800);

  const initialsInput = page.locator('input[name="initials"]');
  if (await initialsInput.count()) {
    opts.onStatus?.(`Practice complete — submitting initials (${initials})`);
    await revealBelowFold(page, initialsInput.first());
    await humanPause(400, 900);
    await initialsInput.fill(initials);
    await humanPause(500, 1000);
    await page.locator("input.subbutton").click({ timeout: 15000 }).catch(() => undefined);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await humanPause(1500, 2800);
    console.log(`[practice] After initials → ${page.url()}`);
  } else {
    const { clickReviewCallsCta, hasReviewQueueCta } = await import("./reviewQueue");
    if (await hasReviewQueueCta(page)) {
      opts.onStatus?.("Practice done — clicking REVIEW CALLS");
      await clickReviewCallsCta(page);
      await humanPause(2000, 3500);
    } else {
      console.warn("[practice] No initials form and no REVIEW CALLS button");
    }
  }

  console.log(`[practice] Finished ${correctCount}/${blocks.length} marked correct`);
  return correctCount >= blocks.length ? "done" : "partial";
}
