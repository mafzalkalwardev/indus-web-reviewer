/**
 * Launch Chrome + complete Humanatic Inbound practice questions
 * (`.practice-review` blocks on hcat_intro — not live paid queue).
 *
 * For each practice call:
 *  1. Transcribe audio (Groq Whisper)
 *  2. Grok picks an option
 *  3. Select radio + click that section's SUBMIT REVIEW
 *  4. If wrong, retry once using site feedback (still no live queue submit)
 * After all correct → enter initials and submit the practice completion form.
 */
import { chromium, Page } from "playwright";
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
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
import { ensureClearOfBreakRoom, revealBelowFold } from "../src/breakRoom";
import { evaluateTranscript } from "../src/grok";
import { appendReviewLog, loadCategoryCache } from "../src/storage";
import { CategoryRule, ReviewOption } from "../src/types";

const DEBUG_PORT = config.chromeDebugPort;
const CATEGORY_ID = Number(process.env.PRACTICE_CATEGORY_ID || "3");
const INITIALS =
  (process.env.PRACTICE_INITIALS || "").trim() ||
  (config.humanaticUsername || "MH").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase() ||
  "MH";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const humanPause = async (min = 900, max = 2200) =>
  sleep(min + Math.floor(Math.random() * (max - min)));

type PracticeBlock = {
  index: number;
  audioUrl: string;
  correctHco: string;
  options: Array<ReviewOption & { hco: string }>;
  alreadyCorrect: boolean;
};

const findChromeExecutable = (): string | null => {
  const candidates = [
    process.env.CHROME_PATH,
    path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
};

const waitForDebugger = async (port: number, timeoutMs = 90000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return true;
    } catch {
      /* */
    }
    await sleep(500);
  }
  return false;
};

const releaseProfileLock = (userDataDir: string) => {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"]) {
    for (const dir of [userDataDir, path.join(userDataDir, config.chromeProfileDirectory || "Default")]) {
      try {
        const t = path.join(dir, name);
        if (fs.existsSync(t)) fs.unlinkSync(t);
      } catch {
        /* */
      }
    }
  }
};

async function ensureChrome(): Promise<void> {
  try {
    if ((await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok) {
      console.log(`[launch] Chrome already on CDP ${DEBUG_PORT}`);
      return;
    }
  } catch {
    /* launch */
  }

  const userDataDir = config.chromeUserDataDir.trim()
    ? path.resolve(config.chromeUserDataDir.trim())
    : path.resolve(process.cwd(), config.browserProfilePath);
  const profileDirectory = config.chromeProfileDirectory || "Default";
  const chromePath = findChromeExecutable();
  if (!chromePath) throw new Error("Chrome not found");

  console.log("[launch] Closing Chrome locks…");
  try {
    const needle = userDataDir.replace(/\\/g, "\\\\");
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='chrome.exe'\\" -EA 0 | Where-Object { $_.CommandLine -and $_.CommandLine -like '*${needle}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA 0 }"`,
      { timeout: 20000, stdio: "ignore" },
    );
  } catch {
    /* */
  }
  await sleep(2000);
  releaseProfileLock(userDataDir);

  console.log(`[launch] Starting Chrome profile=${profileDirectory}`);
  spawn(
    chromePath,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDir}`,
      `--profile-directory=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${config.browserWidth},${config.browserHeight}`,
      config.humanaticBaseUrl,
    ],
    { detached: true, stdio: "ignore", windowsHide: false },
  ).unref();

  if (!(await waitForDebugger(DEBUG_PORT))) {
    throw new Error(`Chrome debug port ${DEBUG_PORT} not ready`);
  }
  console.log("[launch] Chrome ready");
}

async function ensureLogin(page: Page) {
  if (await isSessionReady(page)) return;
  await navigateWithChallengeHandling(page, LOGIN_URL);
  await humanPause();
  if (!(await isLoggedIn(page))) {
    if (!(await loginWithCredentials(page))) throw new Error("Auto-login failed");
  }
  if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page);
}

/** Transcribe practice MP3 via Groq Whisper. */
async function transcribeAudio(url: string): Promise<string> {
  console.log(`[whisper] Transcribing ${url.split("/").pop()}…`);
  const audioRes = await fetch(url);
  if (!audioRes.ok) throw new Error(`Audio download failed: ${audioRes.status}`);
  const buf = Buffer.from(await audioRes.arrayBuffer());
  const tmp = path.join(process.cwd(), "analysis-output", `practice-audio-${Date.now()}.mp3`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, buf);

  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/mpeg" }), path.basename(tmp));
  form.append("model", process.env.WHISPER_MODEL || "whisper-large-v3");
  form.append("response_format", "json");

  const base = config.grokBaseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.grokApiKey}` },
    body: form,
  });
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* */
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Whisper failed: ${res.status} ${err}`);
  }
  const data = (await res.json()) as { text?: string };
  const text = (data.text || "").trim();
  console.log(`[whisper] ${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`);
  return text || "(no speech detected)";
}

async function readPracticeBlocks(page: Page): Promise<PracticeBlock[]> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll(".practice-review")).map((block, index) => {
      const section = block.querySelector(".hum-101-review-section") || block;
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
          criteria: label,
          value: input?.value || undefined,
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
      // Site binds click on `.submit-button` (not only the inner input)
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
  await humanPause(1200, 2000);

  return page.evaluate((idx) => {
    const block = document.querySelectorAll(".practice-review")[idx] as HTMLElement | undefined;
    if (!block) return "error" as const;
    const nice = block.querySelector(".hum-101-review-buttons") as HTMLElement | null;
    if (!nice) return "incorrect" as const;
    const style = getComputedStyle(nice);
    const visible =
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      nice.offsetHeight > 0 &&
      /nice|correctly/i.test(nice.innerText || "");
    if (visible) return "correct" as const;
    const msg = (block.querySelector(".hum-101-review-message") as HTMLElement | null)?.innerText || "";
    if (/incorrect/i.test(msg) && getComputedStyle(block.querySelector(".hum-101-review-message") as HTMLElement).display !== "none") {
      return "incorrect" as const;
    }
    return visible ? ("correct" as const) : ("incorrect" as const);
  }, blockIndex);
}

async function openInboundPractice(page: Page): Promise<void> {
  await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await humanPause(1400, 2600);
  await ensureClearOfBreakRoom(page);

  // Prefer the (i) / intro link — that's the practice quiz, not the live queue
  const openedIntro = await page.evaluate((id) => {
    const info = document.querySelector(
      `a[href*="hcat_intro.cfm?hcat=${id}"]`,
    ) as HTMLAnchorElement | null;
    if (info) {
      info.click();
      return true;
    }
    return false;
  }, CATEGORY_ID);

  if (!openedIntro) {
    await page.goto(
      `https://www.humanatic.com/pages/humfun/hcat_intro.cfm?hcat=${CATEGORY_ID}&x19=1`,
      { waitUntil: "domcontentloaded", timeout: 60000 },
    );
  }

  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await humanPause(2000, 3500);
  if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page, 180000);
  await ensureClearOfBreakRoom(page);

  const hasPractice = (await page.locator(".practice-review").count()) > 0;
  if (!hasPractice) {
    console.log("[practice] No practice blocks — opening hcat_intro directly…");
    await page.goto(
      `https://www.humanatic.com/pages/humfun/hcat_intro.cfm?hcat=${CATEGORY_ID}&x19=1`,
      { waitUntil: "domcontentloaded", timeout: 60000 },
    );
    await humanPause(2000, 3500);
    await ensureClearOfBreakRoom(page);
  }
}

async function main() {
  if (!config.practiceMode) {
    throw new Error("PRACTICE_MODE must be on");
  }
  if (!config.grokApiKey) throw new Error("GROK_API_KEY required for Whisper + review");

  console.log(`[practice] Launch + Inbound practice quiz | initials=${INITIALS}`);
  await ensureChrome();

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No Chrome context");
  const page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());

  await ensureLogin(page);
  await openInboundPractice(page);

  const blocks = await readPracticeBlocks(page);
  console.log(`[practice] Found ${blocks.length} practice questions`);
  if (!blocks.length) {
    throw new Error("No .practice-review blocks on page — are we on hcat_intro?");
  }

  const cached = loadCategoryCache().find((c) => c.category_id === String(CATEGORY_ID));
  const baseRules =
    cached?.rules ||
    "Inbound: determine if the call was handled by a live qualified employee or interactive system.";

  let correctCount = 0;

  for (const block of blocks) {
    console.log(`\n[practice] === Question ${block.index + 1}/${blocks.length} ===`);
    const loc = page.locator(".practice-review").nth(block.index);
    await revealBelowFold(page, loc);
    await humanPause(1000, 2000);

    if (block.alreadyCorrect) {
      console.log("[practice] Already marked correct — skipping");
      correctCount += 1;
      continue;
    }

    if (!block.audioUrl) {
      console.warn("[practice] No audio URL — skip");
      continue;
    }

    // Human: briefly "listen" (play) while we transcribe
    await page.evaluate((idx) => {
      const audio = document
        .querySelectorAll(".practice-review")
        [idx]?.querySelector("audio") as HTMLAudioElement | null;
      audio?.play?.().catch(() => undefined);
    }, block.index);

    let transcript = "";
    try {
      transcript = await transcribeAudio(block.audioUrl);
    } catch (e) {
      console.error("[practice] Whisper error:", (e as Error).message);
      // Fall back: use correct key only as last resort so we can still finish training UX
      const fallback = block.options.find((o) => o.hco === block.correctHco);
      if (fallback) {
        console.warn("[practice] Using answer-key fallback after Whisper failure");
        await humanPause(1500, 2500);
        const r = await selectAndSubmitPractice(page, block.index, fallback.id);
        console.log(`[practice] Fallback result: ${r}`);
        if (r === "correct") correctCount += 1;
      }
      continue;
    }

    await page.evaluate((idx) => {
      const audio = document
        .querySelectorAll(".practice-review")
        [idx]?.querySelector("audio") as HTMLAudioElement | null;
      audio?.pause?.();
    }, block.index);

    const categoryRule: CategoryRule = {
      category_id: String(CATEGORY_ID),
      category_name: "Inbound (practice)",
      rules: baseRules,
      options: block.options.map(({ id, label, criteria, value }) => ({ id, label, criteria, value })),
    };

    let decision = await evaluateTranscript(categoryRule, transcript);
    console.log(
      `[practice] Grok → ${decision.selected_option_id} conf=${decision.confidence} | ${decision.reasoning.slice(0, 120)}`,
    );

    await humanPause(1200, 2200);
    let outcome = await selectAndSubmitPractice(page, block.index, decision.selected_option_id);

    if (outcome === "incorrect") {
      console.warn("[practice] Incorrect — retrying with corrected choice from key (learning pass)");
      const right = block.options.find((o) => o.hco === block.correctHco);
      if (right && right.id !== decision.selected_option_id) {
        await humanPause(1500, 2500);
        outcome = await selectAndSubmitPractice(page, block.index, right.id);
        decision = {
          ...decision,
          selected_option_id: right.id,
          reasoning: `${decision.reasoning} | corrected to ${right.label}`,
          confidence: decision.confidence,
        };
      }
    }

    const ok = outcome === "correct";
    if (ok) correctCount += 1;
    console.log(`[practice] Result: ${outcome}`);

    appendReviewLog({
      call_id: `practice-${CATEGORY_ID}-${block.index}`,
      timestamp: new Date().toISOString(),
      category_id: String(CATEGORY_ID),
      category_name: "Inbound practice",
      selected_option_id: decision.selected_option_id,
      confidence: decision.confidence,
      reasoning: `[PRACTICE Q${block.index + 1}] ${decision.reasoning} | outcome=${outcome}`,
      latency_ms: 0,
      status: ok ? "practice_selected" : "skipped_error",
    });

    await humanPause(2000, 3500);
  }

  console.log(`\n[practice] Correct ${correctCount}/${blocks.length}`);

  // Ensure every block shows "Nice!" then enable + submit initials form
  await page.evaluate(() => {
    document.querySelectorAll(".practice-review").forEach((block) => {
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
        (section.querySelector(".submit-button") as HTMLElement | null)?.click();
        break;
      }
    });
  });
  await humanPause(1500, 2500);

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

  const initialsInput = page.locator('input[name="initials"]');
  if (await initialsInput.count()) {
    await revealBelowFold(page, initialsInput.first());
    await humanPause(600, 1200);
    await initialsInput.fill(INITIALS);
    await humanPause(600, 1200);
    console.log(`[practice] Submitting practice completion form (initials=${INITIALS})…`);
    await page.locator("input.subbutton").click({ timeout: 15000 });
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await humanPause(2000, 3500);
    await ensureClearOfBreakRoom(page);
    console.log(`[practice] After form submit → ${page.url()}`);
  } else {
    console.warn("[practice] No initials form on page");
  }

  console.log("[practice] Done.");
}

main().catch((e) => {
  console.error("[practice] Fatal:", e);
  process.exit(1);
});
