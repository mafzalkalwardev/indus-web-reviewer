/**
 * End-to-end scene intelligence test (launches its own CDP Chrome).
 * Stop the Electron app worker first so the CDP profile is free.
 */
import "dotenv/config";
import { detectPageScene, formatSceneLog } from "../src/pageScene";
import { completePracticeIntro } from "../src/practiceIntro";
import { ensureClearOfBreakRoom } from "../src/breakRoom";
import { createCdpContext, resolveUserDataDir } from "../src/chromeCdp";
import {
  loginWithCredentials,
  isLoggedIn,
  isSessionReady,
  waitForFaceVerifyClear,
  isOnFaceVerifyPage,
  openCategoryViaReviewClick,
} from "../src/session";
import { navigateWithChallengeHandling } from "../src/verification";
import { LOGIN_URL } from "../src/categories";
import { config } from "../src/config";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureLogin(page: import("playwright").Page) {
  if (await isSessionReady(page)) return;
  await navigateWithChallengeHandling(page, LOGIN_URL);
  await sleep(1000);
  if (!(await isLoggedIn(page))) {
    if (!(await loginWithCredentials(page))) throw new Error("Auto-login failed");
  }
  if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page);
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main() {
  console.log(`[test] CDP profile: ${resolveUserDataDir()}`);
  const { browser, context } = await createCdpContext();
  if (!context) throw new Error("No context");
  const page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());

  console.log("[test] Ensuring login…");
  await ensureLogin(page);
  await sleep(3000);

  let scene = await detectPageScene(page);
  console.log(formatSceneLog(scene));

  // Drive toward category 4 practice / queue
  const catId = 4;
  if (
    scene.kind === "category_list" ||
    scene.kind === "profile" ||
    scene.kind === "no_calls" ||
    scene.action === "open_category"
  ) {
    console.log(`[test] Opening category #${catId} via REVIEW…`);
    const result = await openCategoryViaReviewClick(page, catId);
    console.log(`[test] openCategory → ${result}`);
    await ensureClearOfBreakRoom(page).catch(() => undefined);
    scene = await detectPageScene(page);
    console.log(formatSceneLog(scene));
  }

  // If already on practice from prior session
  if (scene.action === "complete_practice" || scene.kind === "practice_intro") {
    assert(scene.details.practiceBlocks >= 1, "practice scene must have blocks");
    assert(scene.confidence >= 0.85, `low confidence ${scene.confidence}`);
    console.log(
      `[test] Detected practice: ${scene.details.practiceBlocks} blocks, radios=${scene.details.radios}, keys present`,
    );

    const result = await completePracticeIntro(page, {
      categoryId: catId,
      onStatus: (m) => console.log(`  · ${m}`),
    });
    console.log(`[test] practice result → ${result}`);
    await ensureClearOfBreakRoom(page).catch(() => undefined);

    const after = await detectPageScene(page);
    console.log(formatSceneLog(after));
    assert(
      after.action !== "complete_practice" ||
        after.details.practiceDone >= after.details.practiceBlocks ||
        after.details.hasReviewCalls ||
        after.kind !== "practice_intro",
      `still stuck on practice after completion (kind=${after.kind} action=${after.action})`,
    );
    console.log("[test] PASS — scene detection + practice completion");
  } else if (scene.action === "review_call" || scene.kind === "live_review") {
    assert(scene.details.radios >= 3, "live review needs radios");
    console.log("[test] PASS — detected live review scene (no practice gate)");
  } else if (scene.kind === "call_intro") {
    console.log("[test] PASS — detected call intro (settling)");
  } else if (scene.kind === "no_calls") {
    console.log("[test] PASS — detected empty queue (noCalls)");
  } else {
    console.log(
      `[test] PASS (soft) — classified as ${scene.kind}/${scene.action}: ${scene.summary}`,
    );
    assert(scene.confidence > 0.3, "scene confidence too low");
  }

  console.log(`[test] practiceMode config=${config.practiceMode}`);
  await browser.close().catch(() => undefined);
  process.exit(0);
}

main().catch((e) => {
  console.error("[test] FATAL:", e);
  process.exit(1);
});
