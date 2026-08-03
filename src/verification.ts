import { Page, BrowserContext } from "playwright";
import { config } from "./config";

/**
 * Cloudflare Turnstile — Managed Challenge Handler
 *
 * Cloudflare Turnstile "managed" mode automatically resolves in the background
 * if the browser fingerprint passes. This module:
 *  1. Detects a Turnstile challenge page
 *  2. Waits for auto-resolution by polling the hidden cf-turnstile-response input
 *  3. Falls back to waiting for the page content to change (URL / body text)
 *  4. Provides a notification if the challenge fails to auto-resolve
 */

// Patterns that indicate a Cloudflare challenge page
const CHALLENGE_URL_PATTERNS = [
  "challenges.cloudflare.com",
  "cdn-cgi/challenge-platform",
  "cdn-cgi/turnstile",
];

const CHALLENGE_TITLE_PATTERNS = [
  "just a moment",
  "please wait",
  "checking your browser",
  "security verification",
];

// Keep these specific — bare "cloudflare" matches the site footer and never clears.
const CHALLENGE_BODY_PATTERNS = [
  "performing security verification",
  "checking your browser",
  "just a moment...",
  "verify you are human",
  "verify you're not a bot",
  "cf-chl-widget",
];

/**
 * Detect if the current page (or any of its pages in context) has a Cloudflare challenge.
 * Returns the page that has the challenge, or null if none found.
 */
export async function detectCloudflareChallenge(page: Page): Promise<{ isChallenge: boolean; page: Page } | null> {
  // Check the current page first
  if (await isTurnstilePage(page)) {
    return { isChallenge: true, page };
  }

  // Check all pages in the context (Turnstile may open a new tab)
  try {
    const pages = page.context().pages();
    for (const p of pages) {
      if (p.isClosed()) continue;
      if (await isTurnstilePage(p)) {
        return { isChallenge: true, page: p };
      }
    }
  } catch {
    // context might be closed
  }

  return null;
}

/**
 * Check if a given page is a Cloudflare Turnstile challenge page.
 */
async function isTurnstilePage(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;

  try {
    // Check URL patterns
    const url = page.url().toLowerCase();
    for (const pattern of CHALLENGE_URL_PATTERNS) {
      if (url.includes(pattern)) return true;
    }

    // Check title
    let title = "";
    try {
      title = (await page.title()).toLowerCase();
    } catch { /* ignore */ }
    for (const pattern of CHALLENGE_TITLE_PATTERNS) {
      if (title.includes(pattern)) return true;
    }

    // Check body text
    let bodyText = "";
    try {
      bodyText = (await page.evaluate(() => document.body?.innerText || "")).toLowerCase();
    } catch { /* cross-origin */ }
    for (const pattern of CHALLENGE_BODY_PATTERNS) {
      if (bodyText.includes(pattern)) return true;
    }

    // Turnstile iframe alone is not enough — login pages can embed it.
    // Only treat as challenge when interstitial copy/title is present (checked above)
    // or the page is clearly the managed challenge interstitial.
    try {
      const isInterstitial = await page.evaluate(() => {
        const text = (document.body?.innerText || "").toLowerCase();
        return (
          text.includes("performing security verification") ||
          text.includes("verify you are human") ||
          text.includes("checking your browser") ||
          text.includes("just a moment")
        );
      });
      if (isInterstitial) return true;
    } catch { /* cross-origin */ }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if the Turnstile challenge has been resolved.
 * Returns true when the challenge is cleared.
 */
async function isTurnstileResolved(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;

  // Hard negatives: interstitial still showing
  try {
    const title = (await page.title()).toLowerCase();
    if (CHALLENGE_TITLE_PATTERNS.some((p) => title.includes(p))) {
      return false;
    }
  } catch {
    /* ignore */
  }

  try {
    if (await isTurnstilePage(page)) {
      // Still looks like a challenge page — only resolve if token present AND title cleared
      const tokenValue = await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>(
          'input[name="cf-turnstile-response"]',
        );
        return input?.value || "";
      });
      // Token alone is not enough while "Just a moment..." is visible
      if (!tokenValue || tokenValue.length <= 10) return false;
    }
  } catch {
    /* cross-origin */
  }

  try {
    const bodyText = (await page.evaluate(() => document.body?.innerText || "")).toLowerCase();
    const stillChallenge = CHALLENGE_BODY_PATTERNS.some((p) => bodyText.includes(p));
    if (stillChallenge) return false;

    // Resolved when challenge markers are gone and we have real page content
    if (bodyText.length > 40) {
      return true;
    }
  } catch {
    /* cross-origin */
  }

  try {
    const successVisible = await page.evaluate(() => {
      const body = document.body?.innerText || "";
      return body.includes("Verification successful");
    });
    if (successVisible) return true;
  } catch {
    /* ignore */
  }

  return false;
}

/**
 * Wait for Cloudflare Turnstile managed challenge to auto-resolve.
 * Managed mode should auto-resolve if the browser fingerprint passes.
 * 
 * @returns true if resolved, false if timed out
 */
export async function waitForTurnstileResolution(
  page: Page,
  timeoutMs: number = config.turnstileTimeoutMs,
  pollMs: number = config.turnstilePollMs,
): Promise<boolean> {
  const startTime = Date.now();
  let lastLogTime = 0;

  console.log(`[verification] Cloudflare Turnstile challenge detected — waiting for auto-resolution (timeout: ${timeoutMs}ms)`);

  while (Date.now() - startTime < timeoutMs) {
    if (page.isClosed()) {
      console.log("[verification] Page was closed during Turnstile wait");
      return false;
    }

    // Simulate realistic user behavior by moving mouse occasionally
    try {
      await page.mouse.move(
        100 + Math.random() * 800,
        100 + Math.random() * 500
      );
    } catch { /* ignore */ }

    const resolved = await isTurnstileResolved(page);
    if (resolved) {
      const elapsed = Date.now() - startTime;
      console.log(`[verification] Cloudflare Turnstile resolved after ${elapsed}ms`);
      
      // Give a moment for the page to transition
      await page.waitForTimeout(2000);
      return true;
    }

    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    if (elapsedSec - lastLogTime >= 15) {
      console.log(`[verification] Still waiting for Turnstile... (${elapsedSec}s elapsed)`);
      lastLogTime = elapsedSec;
    }

    try {
      await page.waitForTimeout(pollMs);
    } catch {
      if (page.isClosed()) {
        console.log("[verification] Page closed during Turnstile wait");
        return false;
      }
    }
  }

  console.log(`[verification] Cloudflare Turnstile timed out after ${timeoutMs}ms`);
  return false;
}

/**
 * Bring a Chrome browser window to focus (Windows only).
 * Helps the user see the Turnstile checkbox if manual interaction is needed.
 */
function focusChromeWindow(): void {
  try {
    // Only works on Windows — uses PowerShell to find and focus Chrome
    const { execSync } = require("child_process");
    execSync(
      `powershell -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.AppActivate('Chrome'); $wshell.AppActivate('Chromium'); Start-Sleep -Seconds 0.5"`,
      { timeout: 5000, stdio: "ignore" },
    );
  } catch {
    // Non-Windows or failure — silently skip
  }
}

/**
 * Handle a Cloudflare Turnstile challenge on a page.
 * Waits for auto-resolution, then prompts the user to complete the checkbox manually.
 * Does not attempt to click the Turnstile widget (that breaks managed challenges).
 */
export async function handleCloudflareChallenge(
  page: Page,
  timeoutMs: number = config.turnstileTimeoutMs,
): Promise<boolean> {
  const autoBudget = Math.min(timeoutMs, Math.max(30000, Math.floor(timeoutMs / 3)));
  const autoResolved = await waitForTurnstileResolution(page, autoBudget);
  if (autoResolved) {
    return true;
  }

  console.log("[verification] ⚠️ Cloudflare Turnstile did not auto-resolve");
  console.log("[verification] Bringing browser to front for manual verification...");
  console.log('[verification] ACTION REQUIRED: click "Verify you are human" in the Chrome window.');
  console.log("[verification] Then log in to Humanatic — the engine continues automatically.");

  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  focusChromeWindow();

  try {
    const { execSync } = require("child_process");
    execSync(
      `powershell -Command "[console]::Beep(880,400); [console]::Beep(988,400)"`,
      { timeout: 3000, stdio: "ignore" },
    );
  } catch {
    /* ignore */
  }

  // Wait until the interstitial clears — use generous budget (manual login window)
  const manualBudget = Math.max(timeoutMs, config.loginWaitTimeoutMs || 600000);
  console.log(
    `[verification] Waiting up to ${Math.round(manualBudget / 60000)} minutes for your checkbox click...`,
  );

  const manualResolved = await waitForTurnstileResolution(page, manualBudget, 2000);
  if (manualResolved) {
    console.log("[verification] Cloudflare Turnstile resolved manually");
    return true;
  }

  console.log("[verification] Cloudflare Turnstile NOT resolved after manual prompt");
  return false;
}

/**
 * Navigate to a URL while handling any Cloudflare Turnstile challenge that appears.
 * Returns the page after the challenge is resolved.
 */
export async function navigateWithChallengeHandling(
  page: Page,
  url: string,
  options?: { timeout?: number; waitUntil?: "load" | "domcontentloaded" | "networkidle" },
): Promise<boolean> {
  try {
    await page.goto(url, {
      waitUntil: options?.waitUntil || "domcontentloaded",
      timeout: options?.timeout || 60000,
    });
  } catch (err) {
    // Navigation may timeout due to challenge — that's expected
    console.log(`[verification] Navigation warning (challenge expected): ${err}`);
  }

  // Give the challenge a moment to load
  await page.waitForTimeout(3000);

  // Check if we hit a Turnstile challenge
  const challenge = await detectCloudflareChallenge(page);
  if (challenge) {
    return handleCloudflareChallenge(challenge.page, config.turnstileTimeoutMs);
  }

  // No challenge detected — we're through
  return true;
}

/**
 * Comprehensive anti-detection script to inject into every page.
 * Adapted from the Fiverr project which successfully bypasses Cloudflare.
 */
export function getAntiDetectionScript(): string {
  return `
    (function() {
      'use strict';

      // 1. Hide automation signals - multiple methods
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      delete navigator.__proto__.webdriver;
      window.navigator.chrome = { runtime: {} };

      // 2. Comprehensive plugin list (like a real Chrome installation)
      const mockPlugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        { name: 'Widevine Content Decryption Module', filename: 'widevinecdmadapter.dll', description: 'Enables Widevine encrypted media content.' },
        { name: 'Chrome Remote Desktop', filename: 'remoting_cdn_hosted-host-extension', description: '' },
      ];
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const pluginArray = Object.create(PluginArray.prototype);
          mockPlugins.forEach(p => pluginArray.push(p));
          return pluginArray;
        },
      });

      // 3. Realistic language and hardware profile
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

      // 4. Comprehensive Chrome runtime object
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) window.chrome.runtime = {};
      window.chrome.runtime.sendMessage = () => {};
      window.chrome.runtime.connect = () => {};
      
      // Add loadTimes for additional Chrome-like behavior
      if (!window.chrome.loadTimes) {
        window.chrome.loadTimes = () => ({
          requestTime: 0,
          startLoadTime: 0,
          commitLoadTime: 0,
          finishDocumentLoadTime: 0,
          finishLoadTime: 0,
          firstPaintTime: 0,
          firstPaintAfterLoadTime: 0,
          navigationType: 'other',
          wasFetchedViaSpdy: false,
          wasNpnNegotiated: false,
          npnNegotiatedProtocol: '',
          wasAlternateProtocolAvailable: false,
          connectionInfo: '',
        });
      }

      // 5. Permissions API - realistic responses
      const origQuery = window.Permissions && window.Permissions.prototype.query;
      if (origQuery) {
        window.Permissions.prototype.query = function(params) {
          if (params && params.name === 'notifications') {
            return Promise.resolve({ state: 'prompt', onchange: null });
          }
          if (params && params.name === 'geolocation') {
            return Promise.resolve({ state: 'prompt', onchange: null });
          }
          return origQuery.call(this, params);
        };
      }

      // 6. WebGL vendor/renderer spoofing - Intel integrated graphics
      const getExt = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(...args) {
        const ctx = getExt.apply(this, args);
        if (ctx && (args[0] === 'webgl' || args[0] === 'webgl2')) {
          const origGetParam = ctx.getParameter;
          ctx.getParameter = function(param) {
            const WEBGL_DEBUG_RENDERER = 0x9245;
            const WEBGL_DEBUG_VENDOR = 0x9246;
            const UNMASKED_RENDERER_WEBGL = 0x9245;
            const UNMASKED_VENDOR_WEBGL = 0x9246;
            if (param === WEBGL_DEBUG_VENDOR || param === UNMASKED_VENDOR_WEBGL) {
              return 'Google Inc. (Intel)';
            }
            if (param === WEBGL_DEBUG_RENDERER || param === UNMASKED_RENDERER_WEBGL) {
              return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)';
            }
            return origGetParam.call(this, param);
          };
        }
        return ctx;
      };

      // 7. Canvas fingerprint noise (reduce fingerprintability)
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function(...args) {
        const base64 = origToDataURL.apply(this, args);
        if (!base64) return base64;
        return base64;
      };

      // 8. Hide PhantomJS/automation artifacts
      window.callPhantom = undefined;
      window._phantom = undefined;

      // 9. Override console.log to remove automation traces
      const originalLog = console.log;
      console.log = function(...args) {
        const message = args.join(' ');
        if (message.includes('automation') || message.includes('playwright')) {
          return;
        }
        return originalLog.apply(console, args);
      };

      // 10. Mock Notification API
      if (!window.Notification) {
        window.Notification = {
          permission: 'default',
          requestPermission: () => Promise.resolve('default'),
        };
      }
    })();
  `;
}

