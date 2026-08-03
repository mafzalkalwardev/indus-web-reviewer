/**
 * Deep DOM Analysis Script — Launches persistent browser, navigates to Humanatic,
 * and analyzes every frame, iframe, element, and verification challenge structure.
 * 
 * Usage: npx ts-node scripts/analyze-dom.ts
 */

import { chromium, BrowserContext, Page } from "playwright";
import path from "path";
import fs from "fs";

const profileDir = path.resolve(process.cwd(), ".browser-profile");
const outputDir = path.resolve(process.cwd(), "analysis-output");

async function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function analyze() {
  ensureDir(outputDir);
  
  console.log("=".repeat(80));
  console.log("DEEP DOM ANALYSIS - Humanatic Call Reviewer");
  console.log("=".repeat(80));
  
  // Launch persistent browser with existing profile
  console.log("\n[1] Launching persistent browser...");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const page = context.pages()[0] || await context.newPage();
  
  // Navigate to Humanatic login
  console.log("\n[2] Navigating to https://www.humanatic.com/pages/humfun/login.cfm...");
  try {
    await page.goto("https://www.humanatic.com/pages/humfun/login.cfm", { 
      waitUntil: "domcontentloaded", 
      timeout: 30000 
    });
  } catch (err) {
    console.log(`  Navigation warning: ${err}`);
  }

  // Wait for page to settle
  await page.waitForTimeout(5000);

  // =========================================================
  // ANALYSIS 1: Page basics
  // =========================================================
  console.log("\n" + "=".repeat(80));
  console.log("[3] PAGE BASICS");
  console.log("=".repeat(80));
  
  try {
    const title = await page.title();
    console.log(`  Title: ${title}`);
  } catch (e) { console.log(`  Title: ERROR - ${e}`); }
  
  console.log(`  URL: ${page.url()}`);
  
  try {
    const htmlLength = await page.evaluate(() => document.documentElement.outerHTML.length);
    console.log(`  HTML length: ${htmlLength} chars`);
  } catch (e) { console.log(`  HTML length: ERROR`); }

  // =========================================================
  // ANALYSIS 2: All frames
  // =========================================================
  console.log("\n" + "=".repeat(80));
  console.log("[4] FRAMES ANALYSIS");
  console.log("=".repeat(80));
  
  const framesInfo = await page.evaluate(() => {
    const results: any[] = [];
    const walkFrames = (win: Window, depth: number) => {
      try {
        const frameCount = win.frames.length;
        const hasIframes = win.document.querySelectorAll("iframe").length;
        results.push({
          depth,
          url: win.location.href,
          frameCount,
          hasIframes,
          origin: win.location.origin,
        });
        for (let i = 0; i < frameCount; i++) {
          try {
            walkFrames(win.frames[i], depth + 1);
          } catch (e) {
            results.push({ depth: depth + 1, url: `[CROSS-ORIGIN frame ${i}]`, error: String(e) });
          }
        }
      } catch (e) {
        results.push({ depth, url: `[ERROR]`, error: String(e) });
      }
    };
    walkFrames(window, 0);
    return results;
  });

  console.log(`  Total frames found: ${framesInfo.length}`);
  framesInfo.forEach((f, i) => {
    console.log(`  Frame ${i}: depth=${f.depth}, url=${f.url.slice(0, 120)}${f.error ? ` ERROR: ${f.error}` : ""}`);
  });

  // Playwright frames
  console.log(`\n  Playwright frames: ${page.frames().length}`);
  page.frames().forEach((f, i) => {
    console.log(`  PW Frame ${i}: url=${(f.url() || "about:blank").slice(0, 120)}`);
  });

  // =========================================================
  // ANALYSIS 3: All iframes in main page
  // =========================================================
  console.log("\n" + "=".repeat(80));
  console.log("[5] IFRAME DETAILS");
  console.log("=".repeat(80));
  
  const iframeDetails = await page.evaluate(() => {
    const iframes = document.querySelectorAll("iframe");
    return Array.from(iframes).map((iframe, i) => ({
      index: i,
      id: iframe.id || "(none)",
      name: iframe.name || "(none)",
      src: iframe.src || "(none)",
      className: iframe.className || "(none)",
      width: iframe.width || "auto",
      height: iframe.height || "auto",
      style: iframe.getAttribute("style") || "(none)",
      title: iframe.title || "(none)",
      sandbox: iframe.sandbox?.value || "(none)",
      loading: iframe.loading || "(none)",
      referrerPolicy: iframe.referrerPolicy || "(none)",
    }));
  });
  
  console.log(`  Total iframes: ${iframeDetails.length}`);
  iframeDetails.forEach((ifr) => {
    console.log(`  Iframe ${ifr.index}:`);
    console.log(`    id="${ifr.id}" name="${ifr.name}" src="${ifr.src.slice(0, 100)}"`);
    console.log(`    class="${ifr.className}" title="${ifr.title}"`);
    console.log(`    dimensions: ${ifr.width}x${ifr.height}`);
    console.log(`    loading="${ifr.loading}" sandbox="${ifr.sandbox}"`);
  });

  // =========================================================
  // ANALYSIS 4: Check for verification / captcha content
  // =========================================================
  console.log("\n" + "=".repeat(80));
  console.log("[6] VERIFICATION / CAPTCHA DETECTION");
  console.log("=".repeat(80));
  
  // Search each Playwright frame for challenge text
  for (const frame of page.frames()) {
    try {
      const frameUrl = frame.url().toLowerCase();
      const isChallenge = 
        frameUrl.includes("captcha") || 
        frameUrl.includes("challenge") || 
        frameUrl.includes("human") || 
        frameUrl.includes("perimeterx") ||
        frameUrl.includes("px") ||
        frameUrl.includes("cloudflare") ||
        frameUrl.includes("cf-");
      
      if (isChallenge) {
        console.log(`  🚩 CHALLENGE FRAME: ${frame.url()}`);
      }
      
      const bodyText = await frame.evaluate(() => {
        try {
          return (document.body?.innerText || "").slice(0, 2000);
        } catch { return ""; }
      }).catch(() => "");
      
      if (bodyText) {
        const lower = bodyText.toLowerCase();
        if (
          lower.includes("press") ||
          lower.includes("hold") ||
          lower.includes("verify") ||
          lower.includes("human") ||
          lower.includes("captcha") ||
          lower.includes("challenge") ||
          lower.includes("checking your browser") ||
          lower.includes("cloudflare") ||
          lower.includes("perimeterx") ||
          lower.includes("px-captcha")
        ) {
          console.log(`  🚩 VERIFICATION TEXT in frame ${frame.url().slice(0, 100)}:`);
          console.log(`  ---BEGIN TEXT---`);
          console.log(bodyText.slice(0, 1000));
          console.log(`  ---END TEXT---`);
        }
      }
    } catch {
      // cross-origin frame, can't access
    }
  }

  // =========================================================
  // ANALYSIS 5: Full body text
  // =========================================================
  console.log("\n" + "=".repeat(80));
  console.log("[7] PAGE BODY TEXT (first 3000 chars)");
  console.log("=".repeat(80));
  
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    console.log(bodyText.slice(0, 3000));
  } catch (e) {
    console.log(`  Could not get body text: ${e}`);
  }

  // =========================================================
  // ANALYSIS 6: Important elements by selector
  // =========================================================
  console.log("\n" + "=".repeat(80));
  console.log("[8] KEY ELEMENT ANALYSIS");
  console.log("=".repeat(80));
  
  const selectorsToCheck = [
    // Humanatic login page elements
    "#login-form", ".login-form", "form[action*='login']", "input[type='password']",
    "input[name='username']", "input[name='password']", "input[name='email']",
    "button[type='submit']", ".btn-login", "#loginBtn",
    
    // Iframes and captcha containers
    "iframe[src*='challenge']", "iframe[src*='captcha']", 
    "iframe[src*='perimeterx']", "iframe[src*='px']",
    "iframe[title*='challenge']", "iframe[id*='captcha']",
    
    // PerimeterX / Cloudflare specific
    "#px-captcha", "#px-captcha-container", "#px-captcha-wrapper",
    "[id^='px']", "[class*='px-captcha']", "[class*='cf-']",
    "#cf-please-wait", "#challenge-form", "#challenge-stage",
    
    // Generic challenge indicators
    ".challenge-box", "#challenge-container", ".cf-browser-verification",
    
    // Common containers
    ".main-container", "#main", "#content", ".container",
  ];

  for (const sel of selectorsToCheck) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0) {
        const visible = await page.locator(sel).first().isVisible().catch(() => false);
        const text = await page.locator(sel).first().innerText().catch(() => "");
        console.log(`  ✅ ${sel}: count=${count}, visible=${visible}, text="${text.slice(0, 100)}"`);
      }
    } catch {}
  }

  // =========================================================
  // ANALYSIS 7: Check for Cloudflare challenge specifics
  // =========================================================
  console.log("\n" + "=".repeat(80));
  console.log("[9] CLOUDFLARE SPECIFIC CHECKS");
  console.log("=".repeat(80));
  
  const cfChecks = await page.evaluate(() => {
    const results: any = {};
    
    // Check for Cloudflare challenge div
    results.challengeDiv = document.getElementById("challenge-stage") ? "EXISTS" : "NOT_FOUND";
    results.challengeRunning = document.getElementById("challenge-running") ? "EXISTS" : "NOT_FOUND";
    results.cfPleaseWait = document.getElementById("cf-please-wait") ? "EXISTS" : "NOT_FOUND";
    results.cfBrowserVerification = document.querySelector(".cf-browser-verification") ? "EXISTS" : "NOT_FOUND";
    
    // Check meta tags
    const metas = document.querySelectorAll("meta");
    results.metaTags = Array.from(metas).map(m => ({ name: m.name, content: m.content.slice(0, 100), httpEquiv: m.httpEquiv }));
    
    // Check for Cloudflare cookies
    results.cookies = document.cookie;
    
    // Check for PerimeterX
    results.hasPxScript = document.querySelector("script[src*='perimeterx'], script[src*='px-captcha']") ? true : false;
    
    // Check form elements for login
    const forms = document.querySelectorAll("form");
    results.forms = Array.from(forms).map(f => ({
      id: f.id,
      action: f.action,
      method: f.method,
      inputs: Array.from(f.querySelectorAll("input")).map(i => ({ 
        name: i.name, 
        type: i.type, 
        id: i.id,
        placeholder: i.placeholder,
        autocomplete: i.autocomplete 
      })),
      buttons: Array.from(f.querySelectorAll("button")).map(b => ({ id: b.id, type: b.type, text: b.textContent?.trim() })),
    }));
    
    // Check for body classes/id that might indicate challenge
    results.bodyClasses = document.body.className;
    results.bodyId = document.body.id;
    
    // HTML lang attribute
    results.htmlLang = document.documentElement.lang;
    
    return results;
  }).catch(() => ({ error: "Failed to evaluate" }));
  
  console.log(JSON.stringify(cfChecks, null, 2));

  // =========================================================
  // ANALYSIS 8: Take screenshot
  // =========================================================
  console.log("\n" + "=".repeat(80));
  console.log("[10] TAKING SCREENSHOTS");
  console.log("=".repeat(80));
  
  await page.screenshot({ path: path.join(outputDir, "full-page.png"), fullPage: true });
  console.log("  ✅ Saved: analysis-output/full-page.png");

  // Take screenshot of viewport only
  await page.screenshot({ path: path.join(outputDir, "viewport.png") });
  console.log("  ✅ Saved: analysis-output/viewport.png");

  // =========================================================
  // ANALYSIS 9: Dump key parts of the HTML
  // =========================================================
  console.log("\n" + "=".repeat(80));
  console.log("[11] HTML STRUCTURE (head + key body sections)");
  console.log("=".repeat(80));
  
  const htmlDump = await page.evaluate(() => {
    return {
      head: document.head?.innerHTML?.slice(0, 2000) || "",
      bodyStart: document.body?.innerHTML?.slice(0, 5000) || "",
    };
  }).catch(() => ({ head: "", bodyStart: "" }));
  
  console.log("\n--- HEAD ---");
  console.log(htmlDump.head.slice(0, 2000));
  console.log("\n--- BODY (first 5000 chars) ---");
  console.log(htmlDump.bodyStart.slice(0, 5000));
  
  // Write full HTML to file
  const fullHtml = await page.evaluate(() => document.documentElement?.outerHTML || "").catch(() => "");
  fs.writeFileSync(path.join(outputDir, "page.html"), fullHtml, "utf-8");
  console.log("\n  ✅ Saved: analysis-output/page.html");

  // =========================================================
  // FINAL SUMMARY
  // =========================================================
  console.log("\n" + "=".repeat(80));
  console.log("ANALYSIS COMPLETE");
  console.log("=".repeat(80));
  console.log(`\nAll outputs saved to: ${outputDir}`);
  console.log("\nThe browser window will remain open for you to inspect manually.");
  console.log("Press Ctrl+C in the terminal when you're done.\n");
}

analyze().catch(console.error);

