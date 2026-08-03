/**
 * Deep-map category.cfm + open each available category from the list UI.
 */
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { config } from "../src/config";
import {
  HUMANATIC_CATEGORIES,
  CATEGORY_LIST_URL,
  LOGIN_URL,
  NO_CALLS_URL,
  categoryQueueUrl,
} from "../src/categories";
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

async function main() {
  ensureOut();
  console.log("[map2] Connecting to Chrome on", DEBUG_PORT);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No browser context");
  let page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());

  if (!(await isSessionReady(page))) {
    await navigateWithChallengeHandling(page, LOGIN_URL);
    if (!(await isLoggedIn(page))) {
      if (!(await loginWithCredentials(page))) throw new Error("login failed");
    }
    if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page);
  }

  console.log("[map2] Ready at", page.url());

  await page.goto(CATEGORY_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  if (page.url().includes("login.cfm")) throw new Error("Session expired on category list");

  const list = await page.evaluate(() => {
    const rows: Array<{
      text: string;
      href: string;
      categoryId: number | null;
      availableText: string;
    }> = [];

    const anchors = Array.from(document.querySelectorAll("a[href]"));
    for (const a of anchors) {
      const href = (a as HTMLAnchorElement).href;
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!href) continue;
      const m =
        href.match(/category_selector\.cfm\?category=(\d+)/i) ||
        href.match(/category=(\d+)/i) ||
        href.match(/cat(?:egory)?Id=(\d+)/i);
      const rowText = (a.closest("tr, li, .row, .card, div")?.textContent || text)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      if (m || /review|start|select|calls/i.test(text)) {
        rows.push({
          text,
          href,
          categoryId: m ? Number(m[1]) : null,
          availableText: rowText,
        });
      }
    }

    // Also scrape table cells for counts
    const tables = Array.from(document.querySelectorAll("table")).map((t) =>
      Array.from(t.querySelectorAll("tr"))
        .map((tr) =>
          Array.from(tr.querySelectorAll("td, th"))
            .map((c) => (c.textContent || "").replace(/\s+/g, " ").trim())
            .filter(Boolean),
        )
        .filter((r) => r.length),
    );

    return {
      url: location.href,
      title: document.title,
      body: (document.body?.innerText || "").slice(0, 4000),
      categoryLinks: rows,
      tables,
    };
  });

  fs.writeFileSync(path.join(outDir, "02-category-list.json"), JSON.stringify(list, null, 2));
  await page.screenshot({ path: path.join(outDir, "02-category-list.png"), fullPage: true });
  fs.writeFileSync(path.join(outDir, "02-category-list.html"), await page.content());

  console.log(`[map2] Category list links found: ${list.categoryLinks.length}`);
  list.categoryLinks.slice(0, 40).forEach((l) => {
    console.log(`  - [${l.categoryId ?? "?"}] ${l.text} | ${l.href}`);
  });

  // Cross-reference known IDs vs list
  const foundIds = new Set(
    list.categoryLinks.map((l) => l.categoryId).filter((x): x is number => x != null),
  );
  const availability = HUMANATIC_CATEGORIES.map((c) => ({
    ...c,
    listedOnCategoryPage: foundIds.has(c.id),
    listHref:
      list.categoryLinks.find((l) => l.categoryId === c.id)?.href || categoryQueueUrl(c.id),
  }));

  // Try opening first listed category via its href (not raw x19 if list has better link)
  const tryLinks = list.categoryLinks.filter((l) => l.categoryId != null).slice(0, 5);
  const openResults: unknown[] = [];
  for (const link of tryLinks) {
    try {
      console.log(`[map2] Opening ${link.categoryId} via ${link.href}`);
      await page.goto(link.href, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(2500);
      if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page, 120000);
      const info = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        radios: document.querySelectorAll('input[type="radio"]').length,
        body: (document.body?.innerText || "").slice(0, 800),
      }));
      openResults.push({ categoryId: link.categoryId, ...info });
      console.log(
        `[map2] → ${info.url} title="${info.title}" radios=${info.radios}`,
      );
      await page.screenshot({
        path: path.join(outDir, `open-${link.categoryId}.png`),
        fullPage: true,
      });
      fs.writeFileSync(
        path.join(outDir, `open-${link.categoryId}.json`),
        JSON.stringify(info, null, 2),
      );
    } catch (e) {
      openResults.push({ categoryId: link.categoryId, error: (e as Error).message });
    }
  }

  // Also hit noCalls once more
  await page.goto(NO_CALLS_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);

  const summary = {
    mapped_at: new Date().toISOString(),
    category_list_url: CATEGORY_LIST_URL,
    list,
    known_categories: availability,
    open_results: openResults,
    workflow: {
      login: LOGIN_URL,
      after_login: "profile.cfm or face_verify.cfm (Tampermonkey clears face)",
      category_list: CATEGORY_LIST_URL,
      per_category_queue: "x19/category_selector.cfm?category=N (or link from category.cfm)",
      no_calls: NO_CALLS_URL,
      refresh_strategy:
        "When on noCalls.cfm, navigate to category_selector for the target category id (Tampermonkey DSV script pattern)",
    },
  };

  fs.writeFileSync(path.join(outDir, "WORKFLOW.json"), JSON.stringify(summary, null, 2));
  console.log("[map2] Wrote WORKFLOW.json");
}

main().catch((e) => {
  console.error("[map2] Fatal:", e);
  process.exit(1);
});
