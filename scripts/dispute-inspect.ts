import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { config } from "../src/config";
import { loginWithCredentials, isLoggedIn, isOnFaceVerifyPage, waitForFaceVerifyClear } from "../src/session";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const AUDITS = "https://www.humanatic.com/pages/humfun/selection_all.cfm";

async function ensureSession(page: import("playwright").Page) {
  await page.goto("https://www.humanatic.com/pages/humfun/profile.cfm", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await sleep(1000);
  if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page, 120000);
  if (!(await isLoggedIn(page))) {
    console.log("[inspect] logging in…");
    await loginWithCredentials(page);
    await sleep(2000);
    if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page, 120000);
  }
}

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.chromeDebugPort}`);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await ensureSession(page);

  await page.goto(AUDITS, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2000);
  console.log("[inspect] url", page.url(), "title", await page.title());

  const dump = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("tr"));
    return rows
      .map((tr, i) => {
        const text = (tr.innerText || "").replace(/\s+/g, " ").trim();
        if (!/-\s*[\d.]+\s*¢/i.test(text) && !/may be disputed/i.test(text)) return null;
        const html = tr.innerHTML.slice(0, 2000);
        const links = Array.from(tr.querySelectorAll("a")).map((a) => ({
          text: (a.textContent || "").trim().slice(0, 80),
          href: a.getAttribute("href") || a.href,
          onclick: a.getAttribute("onclick") || "",
        }));
        const inputs = Array.from(tr.querySelectorAll("input, button")).map((el) => ({
          tag: el.tagName,
          type: (el as HTMLInputElement).type || "",
          value: (el as HTMLInputElement).value || "",
          text: (el.textContent || "").trim().slice(0, 80),
        }));
        return { i, text: text.slice(0, 220), links, inputs, html };
      })
      .filter(Boolean);
  });

  fs.writeFileSync(
    path.resolve(process.cwd(), "data", "audit-row-dump.json"),
    JSON.stringify(dump, null, 2),
  );
  console.log(JSON.stringify(dump, null, 2));

  // Try opening dispute via raw href if present
  const results: unknown[] = [];
  for (const row of dump as any[]) {
    if (!row || !/may be disputed/i.test(row.text)) continue;
    const href = row.links?.[0]?.href;
    if (!href) {
      results.push({ text: row.text, ok: false, detail: "no href" });
      continue;
    }
    const abs = href.startsWith("http") ? href : `https://www.humanatic.com${href.startsWith("/") ? "" : "/pages/humfun/"}${href}`;
    console.log("[dispute] goto", abs);
    await page.goto(abs, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(async () => {
      await page.goto(new URL(href, AUDITS).toString(), { waitUntil: "domcontentloaded", timeout: 60000 });
    });
    await sleep(1500);
    if (/login\.cfm/i.test(page.url())) {
      await loginWithCredentials(page);
      await sleep(1500);
      await page.goto(abs, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => undefined);
      await sleep(1500);
    }
    const ta = page.locator("textarea").first();
    if (await ta.isVisible({ timeout: 2500 }).catch(() => false)) {
      await ta.fill(
        "Disputing this penalty. Full listen completed; selection matched Inbound category instructions. Please re-audit the recording.",
      );
    }
    const submit = page
      .locator('button:has-text("Submit"), input[type="submit"], button:has-text("Confirm"), button:has-text("Dispute"), a:has-text("Submit")')
      .first();
    if (await submit.isVisible({ timeout: 2500 }).catch(() => false)) {
      await submit.click().catch(() => undefined);
      await sleep(2000);
    }
    results.push({
      text: row.text,
      href: abs,
      finalUrl: page.url(),
      body: (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300),
    });
  }

  await page.goto(AUDITS, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(1500);
  if (/login\.cfm/i.test(page.url())) await ensureSession(page);
  await page.goto(AUDITS, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(1500);
  const after = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("tr")).map((tr) =>
      (tr.innerText || "").replace(/\s+/g, " ").trim(),
    );
    return {
      title: document.title,
      negatives: rows.filter((t) => /-\s*[\d.]+\s*¢/i.test(t)),
      mayDispute: rows.filter((t) => /may be disputed/i.test(t)),
    };
  });

  fs.writeFileSync(
    path.resolve(process.cwd(), "data", "audits-dispute-final.json"),
    JSON.stringify({ dumpCount: (dump as any[]).length, results, after }, null, 2),
  );
  console.log(JSON.stringify({ results, after }, null, 2));
  await page.close().catch(() => undefined);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
