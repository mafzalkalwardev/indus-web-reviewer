import { Browser, BrowserContext, Page } from "playwright";
import { config } from "./config";
import { ReviewEngine } from "./stateMachine";
import {
  navigateWithChallengeHandling,
  handleCloudflareChallenge,
} from "./verification";
import {
  isLoggedIn,
  waitForManualLogin,
  navigateToReviewQueue,
  loginWithCredentials,
  waitForFaceVerifyClear,
  isOnFaceVerifyPage,
  isSessionReady,
} from "./session";
import { savePageSnapshot } from "./domDiscovery";
import {
  createCdpContext,
  createPlaywrightContext,
  resolveUserDataDir,
  usingRealChromeProfile,
} from "./chromeCdp";

const ensureAuthenticatedSession = async (page: Page): Promise<void> => {
  if (!page.url().includes("humanatic")) {
    console.log(`[auth] Navigating to ${config.humanaticBaseUrl}...`);
    await navigateWithChallengeHandling(page, config.humanaticBaseUrl);
  } else {
    console.log(`[auth] Already on ${page.url()}`);
    await page.waitForTimeout(3000);
  }

  let title = (await page.title().catch(() => "")).toLowerCase();
  if (
    title.includes("just a moment") ||
    title.includes("please wait") ||
    title.includes("checking your browser")
  ) {
    console.log("[auth] Cloudflare challenge visible.");
    console.log('[auth] ACTION REQUIRED: click "Verify you are human", then log in to Humanatic.');
    const ok = await handleCloudflareChallenge(page, Math.max(config.turnstileTimeoutMs, 600000));
    if (!ok) {
      console.log("[auth] Still blocked — waiting for the page title to leave Cloudflare...");
      const start = Date.now();
      while (Date.now() - start < config.loginWaitTimeoutMs) {
        if (page.isClosed()) throw new Error("Browser closed during Cloudflare wait");
        title = (await page.title().catch(() => "")).toLowerCase();
        const url = page.url();
        if (
          !title.includes("just a moment") &&
          !title.includes("please wait") &&
          !title.includes("checking your browser") &&
          !title.includes("security verification")
        ) {
          console.log(`[auth] Challenge cleared: title="${title}" url=${url}`);
          break;
        }
        const elapsed = Math.round((Date.now() - start) / 1000);
        if (elapsed % 30 === 0) {
          console.log(`[auth] Still on Cloudflare (${elapsed}s) — click Verify you are human`);
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  console.log(`[auth] Page ready: title="${await page.title().catch(() => "?")}" url=${page.url()}`);

  if (await isSessionReady(page)) {
    console.log("[auth] Existing ready session detected in Chrome profile.");
    return;
  }

  if (isOnFaceVerifyPage(page)) {
    await waitForFaceVerifyClear(page);
    if (await isSessionReady(page)) return;
  }

  if (config.humanaticUsername && config.humanaticPassword) {
    console.log("[auth] Credentials found in .env — attempting automatic login...");
    const autoOk = await loginWithCredentials(page);
    if (autoOk) {
      if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page);
      if ((await isSessionReady(page)) || (await isLoggedIn(page))) {
        console.log("[auth] Automatic login complete.");
        return;
      }
    }
    console.warn("[auth] Automatic login failed — falling back to manual login.");
  }

  console.log("[auth] Not logged in. Please log in to Humanatic in the Chrome window.");
  console.log("[auth] The engine continues automatically after login — no need to press Enter.");
  const loggedIn = await waitForManualLogin(page, config.loginWaitTimeoutMs);
  if (!loggedIn) {
    await savePageSnapshot(page, "login-timeout");
    throw new Error("Timed out waiting for manual Humanatic login.");
  }

  console.log("[auth] Login saved in your Chrome profile.");
};

const startEngine = async (context: BrowserContext): Promise<void> => {
  const page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());
  await ensureAuthenticatedSession(page);
  await navigateToReviewQueue(page);
  await savePageSnapshot(page, "pre-review").catch(() => undefined);

  console.log("[engine] Starting continuous review engine...");
  const engine = new ReviewEngine(page);
  const summary = await engine.run();

  console.log("[engine] Review run completed.");
  console.log(
    `[engine] submitted=${summary.reviews_submitted} skipped=${summary.reviews_skipped} categories=${summary.categories_seen.length} stop=${summary.stop_reason}`,
  );
};

const main = async () => {
  const userDataDir = resolveUserDataDir();
  console.log("=".repeat(60));
  console.log("Indus Web Reviewer");
  console.log(
    usingRealChromeProfile()
      ? `Chrome profile: ${userDataDir} [${config.chromeProfileDirectory}]`
      : `Automation profile: ${userDataDir}`,
  );
  console.log(`Max calls: ${config.maxReviewCalls} | Idle timeout: ${config.reviewIdleTimeoutMs}ms`);
  console.log("=".repeat(60));
  if (usingRealChromeProfile()) {
    console.log("[main] NOTE: Your normal Chrome will close briefly so this profile can open.");
  }
  console.log("[main] If Cloudflare appears: click Verify you are human, then log in once.");

  const useCdp = process.env.USE_PLAYWRIGHT_CONTEXT !== "1";
  let browser: Browser | null = null;
  let context: BrowserContext;

  try {
    if (useCdp) {
      const cdp = await createCdpContext();
      browser = cdp.browser;
      context = cdp.context;
    } else {
      context = await createPlaywrightContext();
    }

    if (process.argv.includes("--save-auth")) {
      const page = context.pages()[0] || (await context.newPage());
      await ensureAuthenticatedSession(page);
      console.log("[auth] Auth prepare complete. Run npm run dev to start reviewing.");
      return;
    }

    await startEngine(context);
  } catch (error) {
    console.error("[main] Fatal error:", error);
  } finally {
    console.log("[main] Done. Chrome may stay open with your profile session.");
    try {
      if (browser) await browser.close();
    } catch {
      /* ignore */
    }
  }
};

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
