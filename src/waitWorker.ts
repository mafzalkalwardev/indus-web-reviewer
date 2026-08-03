/**
 * Wait-mode worker: Tampermonkey refreshes the selected category queue.
 * This process only watches Chrome (CDP) and reviews when a call screen appears.
 */
import { Page } from "playwright";
import { config } from "./config";
import { LOGIN_URL } from "./categories";
import {
  loginWithCredentials,
  isLoggedIn,
  isSessionReady,
  waitForFaceVerifyClear,
  isOnFaceVerifyPage,
} from "./session";
import { navigateWithChallengeHandling } from "./verification";
import { ensureClearOfBreakRoom, looksLikeBreakRoom } from "./breakRoom";
import {
  captureTranscript,
  inspectPortal,
  readLiveOptions,
  selectReviewChoice,
  submitReviewChoice,
  getCallFingerprint,
} from "./humanatic";
import { evaluateTranscript } from "./grok";
import {
  appendReviewLog,
  loadCategoryCache,
  loadWorkerState,
  patchWorkerStatus,
  saveCategoryCache,
} from "./storage";
import { discoverReviewSelectors } from "./domDiscovery";
import { CategoryRule } from "./types";
import {
  createCdpContext,
  resolveUserDataDir,
  usingRealChromeProfile,
} from "./chromeCdp";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 2500;

const setStatus = (
  state: "idle" | "waiting" | "reviewing" | "break_room" | "error" | "stopped",
  message: string,
  extra: { currentUrl?: string; lastCallAt?: string | null } = {},
) => {
  const patch: Parameters<typeof patchWorkerStatus>[0] = {
    state,
    message,
    pid: process.pid,
  };
  if (extra.currentUrl !== undefined) patch.currentUrl = extra.currentUrl;
  if (extra.lastCallAt !== undefined) patch.lastCallAt = extra.lastCallAt;
  patchWorkerStatus(patch);
};

async function ensureLogin(page: Page) {
  if (await isSessionReady(page)) return;
  await navigateWithChallengeHandling(page, LOGIN_URL);
  await sleep(1000);
  if (!(await isLoggedIn(page))) {
    if (!(await loginWithCredentials(page))) {
      throw new Error("Auto-login failed");
    }
  }
  if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page);
}

/** True when page looks like a real call review (not practice quiz / category list / noCalls). */
async function isLiveReviewScreen(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (
    url.includes("login.cfm") ||
    url.includes("logout.cfm") ||
    url.includes("nocalls.cfm") ||
    url.includes("break_room") ||
    url.includes("category.cfm") ||
    url.includes("face_verify")
  ) {
    return false;
  }

  return page.evaluate(() => {
    const radios = document.querySelectorAll('input[type="radio"]').length;
    const audio = document.querySelector("audio, audio.call-audio");
    const practiceBlocks = document.querySelectorAll(".practice-review").length;
    // Intro practice quiz has multiple .practice-review blocks — skip those
    if (practiceBlocks >= 2) return false;
    // Live review: radios + preferably audio
    if (radios >= 3 && (audio || document.body?.innerText.includes("SUBMIT"))) return true;
    if (radios >= 4) return true;
    return false;
  });
}

async function reviewCurrentCall(page: Page, practiceMode: boolean): Promise<"ok" | "skipped"> {
  const started = Date.now();
  setStatus("reviewing", "Review UI detected — processing call", { currentUrl: page.url() });

  await discoverReviewSelectors(page);
  const metadata = await inspectPortal(page);
  let categoryRule = loadCategoryCache().find((c) => c.category_id === metadata.categoryId);
  const liveOptions = await readLiveOptions(page);

  if (!categoryRule) {
    categoryRule = {
      category_id: metadata.categoryId,
      category_name: metadata.categoryName || `Category ${metadata.categoryId}`,
      rules: liveOptions.map((o) => `- ${o.label}`).join("\n"),
      options: liveOptions,
    };
  } else if (liveOptions.length) {
    categoryRule = { ...categoryRule, options: liveOptions };
  }

  if (!categoryRule.options.length) {
    appendReviewLog({
      call_id: `call-${Date.now()}`,
      timestamp: new Date().toISOString(),
      category_id: metadata.categoryId,
      category_name: categoryRule.category_name,
      selected_option_id: "",
      confidence: 0,
      reasoning: "No options",
      latency_ms: Date.now() - started,
      status: "skipped_no_options",
    });
    return "skipped";
  }

  const cache = loadCategoryCache().filter((c) => c.category_id !== categoryRule!.category_id);
  cache.push(categoryRule as CategoryRule);
  saveCategoryCache(cache);

  let transcript = "";
  try {
    transcript = await captureTranscript(page);
  } catch (e) {
    appendReviewLog({
      call_id: `call-${Date.now()}`,
      timestamp: new Date().toISOString(),
      category_id: metadata.categoryId,
      category_name: categoryRule.category_name,
      selected_option_id: "",
      confidence: 0,
      reasoning: `Transcript failed: ${(e as Error).message}`,
      latency_ms: Date.now() - started,
      status: "skipped_error",
    });
    return "skipped";
  }

  console.log(
    `[wait] Review cat=${categoryRule.category_name} options=${categoryRule.options.length} transcript=${transcript.length}`,
  );

  let decision;
  try {
    decision = await evaluateTranscript(categoryRule, transcript);
  } catch (e) {
    appendReviewLog({
      call_id: `call-${Date.now()}`,
      timestamp: new Date().toISOString(),
      category_id: metadata.categoryId,
      category_name: categoryRule.category_name,
      selected_option_id: "",
      confidence: 0,
      reasoning: (e as Error).message,
      latency_ms: Date.now() - started,
      status: "skipped_error",
    });
    return "skipped";
  }

  if (decision.confidence < config.confidenceThreshold) {
    appendReviewLog({
      call_id: `call-${Date.now()}`,
      timestamp: new Date().toISOString(),
      category_id: metadata.categoryId,
      category_name: categoryRule.category_name,
      selected_option_id: decision.selected_option_id,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      latency_ms: Date.now() - started,
      status: "skipped_low_confidence",
    });
    console.warn(`[wait] Low confidence ${decision.confidence} — skip`);
    return "skipped";
  }

  await sleep(800 + Math.floor(Math.random() * 1200));

  if (practiceMode) {
    await selectReviewChoice(page, decision.selected_option_id);
    appendReviewLog({
      call_id: metadata.callId || `call-${Date.now()}`,
      timestamp: new Date().toISOString(),
      category_id: metadata.categoryId,
      category_name: categoryRule.category_name,
      selected_option_id: decision.selected_option_id,
      confidence: decision.confidence,
      reasoning: `[PRACTICE] ${decision.reasoning}`,
      latency_ms: Date.now() - started,
      status: "practice_selected",
    });
    console.log(`[wait] PRACTICE selected ${decision.selected_option_id}`);
  } else {
    await submitReviewChoice(page, decision.selected_option_id);
    appendReviewLog({
      call_id: metadata.callId || `call-${Date.now()}`,
      timestamp: new Date().toISOString(),
      category_id: metadata.categoryId,
      category_name: categoryRule.category_name,
      selected_option_id: decision.selected_option_id,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      latency_ms: Date.now() - started,
      status: "submitted",
    });
    console.log(`[wait] SUBMITTED ${decision.selected_option_id} conf=${decision.confidence}`);
  }

  setStatus("waiting", practiceMode ? "Practice select done — waiting for next" : "Submitted — waiting for next", {
    currentUrl: page.url(),
    lastCallAt: new Date().toISOString(),
  });

  // Human cooldown
  await sleep(4000 + Math.floor(Math.random() * 5000));
  return "ok";
}

async function main() {
  console.log("[wait] Indus Web Reviewer — wait-mode worker starting…");
  const userDataDir = resolveUserDataDir();
  console.log(
    usingRealChromeProfile()
      ? `[wait] Chrome profile: ${userDataDir} [${config.chromeProfileDirectory}]`
      : `[wait] Automation profile: ${userDataDir}`,
  );
  setStatus("waiting", "Launching / attaching Chrome profile…", { currentUrl: "" });

  let browser;
  let context;
  try {
    const cdp = await createCdpContext();
    browser = cdp.browser;
    context = cdp.context;
  } catch (err) {
    const msg = (err as Error).message || String(err);
    setStatus("error", `Chrome launch failed: ${msg}`);
    throw err;
  }

  if (!context) throw new Error("No Chrome context");
  const page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());

  await ensureLogin(page);
  setStatus("waiting", "Logged in — waiting for Tampermonkey to deliver a call", {
    currentUrl: page.url(),
  });

  let lastFingerprint = "";

  while (true) {
    const { target } = loadWorkerState();

    if (!target.enabled) {
      setStatus("idle", "Target disabled from dashboard — idle", { currentUrl: page.url() });
      await sleep(3000);
      continue;
    }

    try {
      if (await looksLikeBreakRoom(page)) {
        setStatus("break_room", "Break Room — waiting to continue", { currentUrl: page.url() });
        await ensureClearOfBreakRoom(page);
        continue;
      }

      if (page.url().includes("login.cfm")) {
        setStatus("waiting", "Session lost — re-login", { currentUrl: page.url() });
        await ensureLogin(page);
        continue;
      }

      if (await isLiveReviewScreen(page)) {
        const fp = await getCallFingerprint(page);
        if (fp && fp === lastFingerprint) {
          // Same call still on screen (e.g. practice without advance)
          await sleep(POLL_MS);
          continue;
        }

        const result = await reviewCurrentCall(page, target.practiceMode);
        if (result === "ok") {
          lastFingerprint = fp;
        }
        // After submit, TM / site should move on; wait before next detect
        await sleep(POLL_MS);
        continue;
      }

      const catLabel =
        target.categoryId != null
          ? `${target.categoryName || "Category"} (#${target.categoryId})`
          : "no category";
      setStatus(
        "waiting",
        `Waiting for call screen (${catLabel}). Tampermonkey refresh=${target.refreshSeconds}s`,
        { currentUrl: page.url() },
      );
      await sleep(POLL_MS);
    } catch (e) {
      console.error("[wait] Loop error:", e);
      setStatus("error", (e as Error).message, { currentUrl: page.url() });
      await sleep(5000);
    }
  }
}

main().catch((e) => {
  console.error("[wait] Fatal:", e);
  setStatus("error", (e as Error).message);
  process.exit(1);
});
