/**
 * Portal mapper — after login, crawl key Humanatic pages and dump a site map.
 *
 * Usage (with Chrome already authenticated / or via npm run map-portal):
 *   npx ts-node scripts/map-portal.ts
 */
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { config } from "../src/config";
import { HUMANATIC_CATEGORIES, categoryQueueUrl, NO_CALLS_URL, LOGIN_URL } from "../src/categories";
import {
  loginWithCredentials,
  isLoggedIn,
  isSessionReady,
  waitForFaceVerifyClear,
  isOnFaceVerifyPage,
} from "../src/session";
import { navigateWithChallengeHandling } from "../src/verification";

const outDir = path.resolve(process.cwd(), "analysis-output", "portal-map");
const DEBUG_PORT = config.chromeDebugPort;

const ensureOut = () => {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
};

async function snapshot(page: import("playwright").Page, label: string) {
  ensureOut();
  const safe = label.replace(/[^\w.-]+/g, "_");
  const htmlPath = path.join(outDir, `${safe}.html`);
  const pngPath = path.join(outDir, `${safe}.png`);
  const metaPath = path.join(outDir, `${safe}.json`);
  try {
    fs.writeFileSync(htmlPath, await page.content(), "utf-8");
  } catch {
    /* ignore */
  }
  try {
    await page.screenshot({ path: pngPath, fullPage: true });
  } catch {
    /* ignore */
  }

  const meta = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a[href]"))
      .map((a) => ({
        text: (a.textContent || "").trim().slice(0, 80),
        href: (a as HTMLAnchorElement).href,
      }))
      .filter((l) => l.href.includes("humanatic"))
      .slice(0, 80);

    const forms = Array.from(document.querySelectorAll("form")).map((f, i) => ({
      index: i,
      action: f.getAttribute("action") || "",
      method: f.getAttribute("method") || "",
      inputs: Array.from(f.querySelectorAll("input, select, textarea")).map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        value: (el as HTMLInputElement).value?.slice?.(0, 40) || "",
      })),
    }));

    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).map(
      (r) => ({
        name: r.name,
        value: r.value,
        id: r.id,
        label:
          (r.id && document.querySelector(`label[for='${r.id}']`)?.textContent?.trim()) ||
          r.getAttribute("aria-label") ||
          "",
      }),
    );

    return {
      title: document.title,
      url: location.href,
      bodyTextSample: (document.body?.innerText || "").slice(0, 1500),
      links,
      forms,
      radios: radios.slice(0, 40),
      radioCount: radios.length,
    };
  });

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  console.log(`[map] Saved ${safe} — title="${meta.title}" radios=${meta.radioCount}`);
  return meta;
}

async function main() {
  ensureOut();
  console.log("[map] Connecting to Chrome on port", DEBUG_PORT);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());

  if (!(await isSessionReady(page))) {
    console.log("[map] Session not ready — navigating to login...");
    await navigateWithChallengeHandling(page, LOGIN_URL);
    if (!(await isLoggedIn(page))) {
      const ok = await loginWithCredentials(page);
      if (!ok) throw new Error("Auto-login failed during portal map");
    }
    if (isOnFaceVerifyPage(page)) {
      await waitForFaceVerifyClear(page);
    }
  }

  console.log("[map] Session ready at", page.url());

  const report: Record<string, unknown> = {
    mapped_at: new Date().toISOString(),
    start_url: page.url(),
    known_categories: HUMANATIC_CATEGORIES,
    pages: {} as Record<string, unknown>,
    category_probes: [] as unknown[],
  };

  // Current page
  (report.pages as Record<string, unknown>).home = await snapshot(page, "00-current");

  // noCalls page
  try {
    await page.goto(NO_CALLS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);
    (report.pages as Record<string, unknown>).noCalls = await snapshot(page, "01-noCalls");
  } catch (e) {
    console.warn("[map] noCalls failed", (e as Error).message);
  }

  // Probe each known category queue (short visit)
  for (const cat of HUMANATIC_CATEGORIES) {
    try {
      console.log(`[map] Probing category ${cat.name} (${cat.id})...`);
      await page.goto(categoryQueueUrl(cat.id), { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(2000);

      // Face verify can reappear
      if (isOnFaceVerifyPage(page)) {
        await waitForFaceVerifyClear(page, 120000);
      }

      const meta = await snapshot(page, `cat-${cat.id}-${cat.key}`);
      (report.category_probes as unknown[]).push({
        ...cat,
        url: page.url(),
        title: meta.title,
        radioCount: meta.radioCount,
        bodySample: meta.bodyTextSample?.slice(0, 400),
        available:
          meta.radioCount > 0 ||
          /review|transcript|call/i.test(meta.bodyTextSample || "") ||
          /noCalls|no calls|nothing/i.test(meta.bodyTextSample || ""),
        looksEmpty: /no calls|nothing to review|noCalls/i.test(page.url() + (meta.bodyTextSample || "")),
      });
    } catch (e) {
      (report.category_probes as unknown[]).push({
        ...cat,
        error: (e as Error).message,
      });
    }
  }

  const reportPath = path.join(outDir, "SITE_MAP.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`[map] Wrote ${reportPath}`);
  console.log(
    `[map] Categories probed: ${(report.category_probes as unknown[]).length}/${HUMANATIC_CATEGORIES.length}`,
  );

  // Keep browser open — do not close CDP session owned by the engine
}

main().catch((e) => {
  console.error("[map] Fatal:", e);
  process.exit(1);
});
