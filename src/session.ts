import { Page } from "playwright";
import { config } from "./config";
import { DEFAULT_SELECTORS } from "./humanatic";
import { FACE_VERIFY_URL_HINT, categoryQueueUrl, HUMANATIC_CATEGORIES } from "./categories";

const LOGIN_URL_HINTS = ["login.cfm", "/login", "humfun/login"];

/**
 * True when the page looks like the Humanatic login form (not yet authenticated).
 */
export const isOnLoginPage = async (page: Page): Promise<boolean> => {
  if (page.isClosed()) return false;

  try {
    const url = page.url().toLowerCase();
    if (LOGIN_URL_HINTS.some((h) => url.includes(h))) {
      const hasPassword = await page.$(DEFAULT_SELECTORS.passwordInput);
      if (hasPassword) return true;
    }

    const hasLoginForm = await page.evaluate((selectors) => {
      const password = document.querySelector(selectors.passwordInput);
      const submit = document.querySelector(selectors.loginButton);
      return !!(password && submit);
    }, DEFAULT_SELECTORS);

    return hasLoginForm;
  } catch {
    return false;
  }
};

export const isOnFaceVerifyPage = (page: Page): boolean => {
  try {
    return page.url().toLowerCase().includes(FACE_VERIFY_URL_HINT);
  } catch {
    return false;
  }
};

/**
 * True when we appear past login form (may still be on face_verify).
 */
export const isLoggedIn = async (page: Page): Promise<boolean> => {
  if (page.isClosed()) return false;

  try {
    const title = (await page.title()).toLowerCase();
    if (
      title.includes("just a moment") ||
      title.includes("please wait") ||
      title.includes("checking your browser")
    ) {
      return false;
    }

    const url = page.url().toLowerCase();
    if (!url.includes("humanatic.com") && !url.includes("humanatic.ai")) {
      return false;
    }

    // Face verify means credentials were accepted — logged-in-in-progress
    if (url.includes(FACE_VERIFY_URL_HINT)) {
      return true;
    }

    if (LOGIN_URL_HINTS.some((h) => url.includes(h))) {
      if (await isOnLoginPage(page)) return false;
      const body = (await page.evaluate(() => document.body?.innerText || "")).toLowerCase();
      if (
        body.includes("just a moment") ||
        body.includes("verify you are human") ||
        body.includes("checking your browser")
      ) {
        return false;
      }
      return true;
    }

    if (await isOnLoginPage(page)) return false;
    return true;
  } catch {
    return false;
  }
};

/**
 * Fully ready for portal work: logged in and past face verification.
 */
export const isSessionReady = async (page: Page): Promise<boolean> => {
  if (!(await isLoggedIn(page))) return false;
  if (isOnFaceVerifyPage(page)) return false;
  if (await isOnLoginPage(page)) return false;
  return true;
};

/**
 * Wait for Tampermonkey (or user) to clear face_verify.cfm.
 * Face bypass stays in Tampermonkey — we only wait for navigation away.
 */
export const waitForFaceVerifyClear = async (
  page: Page,
  timeoutMs: number = config.loginWaitTimeoutMs,
): Promise<boolean> => {
  if (!isOnFaceVerifyPage(page)) return true;

  console.log("[session] Face verification page detected.");
  console.log("[session] Waiting for Tampermonkey face script to clear face_verify.cfm...");

  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) return false;
    if (!isOnFaceVerifyPage(page)) {
      console.log(
        `[session] Left face_verify after ${Math.round((Date.now() - start) / 1000)}s → ${page.url()}`,
      );
      await page.waitForTimeout(1500);
      return true;
    }
    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (elapsed - lastLog >= 15) {
      console.log(`[session] Still on face_verify... (${elapsed}s)`);
      lastLog = elapsed;
    }
    await page.waitForTimeout(2000);
  }
  console.warn("[session] Timed out waiting for face_verify to clear");
  return false;
};

/**
 * Wait until the user completes manual login (fallback).
 */
export const waitForManualLogin = async (
  page: Page,
  timeoutMs: number = config.loginWaitTimeoutMs,
): Promise<boolean> => {
  const start = Date.now();
  let lastLog = 0;

  console.log("[session] Waiting for you to log in to Humanatic in the browser...");
  console.log(`[session] Timeout: ${Math.round(timeoutMs / 60000)} minutes`);

  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) {
      console.log("[session] Page closed while waiting for login");
      return false;
    }

    if (await isLoggedIn(page)) {
      console.log(`[session] Login detected after ${Math.round((Date.now() - start) / 1000)}s`);
      await waitForFaceVerifyClear(page, timeoutMs);
      return true;
    }

    const elapsedSec = Math.floor((Date.now() - start) / 1000);
    if (elapsedSec - lastLog >= 20) {
      console.log(`[session] Still waiting for login... (${elapsedSec}s) — URL: ${page.url()}`);
      lastLog = elapsedSec;
    }

    await page.waitForTimeout(2000);
  }

  console.log("[session] Timed out waiting for manual login");
  return false;
};

/**
 * Fill and submit the Humanatic login form using credentials from .env.
 */
export const loginWithCredentials = async (page: Page): Promise<boolean> => {
  const username = config.humanaticUsername;
  const password = config.humanaticPassword;

  if (!username || !password) {
    console.log("[session] HUMANATIC_USERNAME / HUMANATIC_PASSWORD not set — skipping auto-login");
    return false;
  }

  const emailSel = DEFAULT_SELECTORS.emailInput;
  const passSel = DEFAULT_SELECTORS.passwordInput;
  const btnSel = DEFAULT_SELECTORS.loginButton;

  console.log("[session] Auto-login: waiting for login form...");
  try {
    await page.waitForSelector(passSel, { timeout: 30000 });
  } catch {
    console.warn("[session] Auto-login: password field not found");
    return false;
  }

  const usernameInput =
    (await page.$(emailSel)) ||
    (await page.$(
      "input[name='username'], input[name='email'], input[name='login'], input[type='email'], input[type='text']",
    ));
  const passwordInput = await page.$(passSel);

  if (!passwordInput) {
    console.warn("[session] Auto-login: could not locate password input");
    return false;
  }

  if (usernameInput) {
    await usernameInput.click({ clickCount: 3 });
    await usernameInput.fill(username);
  } else {
    console.warn("[session] Auto-login: username/email field not found — trying first text input");
    const fallback = await page.$("input[type='text']");
    if (!fallback) return false;
    await fallback.fill(username);
  }

  await passwordInput.click({ clickCount: 3 });
  await passwordInput.fill(password);

  const loginBtn = await page.$(btnSel);
  if (loginBtn) {
    console.log("[session] Auto-login: submitting form...");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined),
      loginBtn.click(),
    ]);
  } else {
    console.log("[session] Auto-login: no button found — pressing Enter");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined),
      passwordInput.press("Enter"),
    ]);
  }

  await page.waitForTimeout(2500);

  const title = (await page.title().catch(() => "")).toLowerCase();
  if (title.includes("just a moment") || title.includes("please wait")) {
    console.log("[session] Challenge after login submit — waiting...");
    const { handleCloudflareChallenge } = await import("./verification");
    await handleCloudflareChallenge(page, config.turnstileTimeoutMs);
  }

  if (isOnFaceVerifyPage(page)) {
    const cleared = await waitForFaceVerifyClear(page);
    if (!cleared) return false;
  }

  if (await isLoggedIn(page)) {
    console.log("[session] Auto-login succeeded");
    return true;
  }

  console.warn(`[session] Auto-login did not clear login page (url=${page.url()})`);
  return false;
};

/**
 * Open a category review queue (same URL Tampermonkey uses from noCalls).
 */
export const openCategoryQueue = async (page: Page, categoryId: number): Promise<void> => {
  const url = categoryQueueUrl(categoryId);
  const cat = HUMANATIC_CATEGORIES.find((c) => c.id === categoryId);
  console.log(`[session] Opening category queue ${cat?.name || categoryId}: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  const { ensureClearOfBreakRoom } = await import("./breakRoom");
  await ensureClearOfBreakRoom(page);
};

/**
 * Try to open the review queue: optional env URL, else default category.
 */
export const navigateToReviewQueue = async (page: Page): Promise<void> => {
  if (config.humanaticReviewUrl) {
    console.log(`[session] Navigating to configured review URL: ${config.humanaticReviewUrl}`);
    await page.goto(config.humanaticReviewUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(2000);
    const { ensureClearOfBreakRoom } = await import("./breakRoom");
    await ensureClearOfBreakRoom(page);
    return;
  }

  // Official nav: Category List page (links to per-category queues)
  const { CATEGORY_LIST_URL } = await import("./categories");
  console.log(`[session] Opening Category List: ${CATEGORY_LIST_URL}`);
  await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);

  if (page.url().toLowerCase().includes("login.cfm")) {
    throw new Error("Session lost — landed on login while opening Category List");
  }
  const { ensureClearOfBreakRoom } = await import("./breakRoom");
  await ensureClearOfBreakRoom(page);
};
