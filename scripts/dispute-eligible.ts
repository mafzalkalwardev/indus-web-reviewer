/**
 * Dispute all eligible "Call may be disputed" penalties without login thrash.
 * Uses Cloudflare-aware navigation + direct selection_review.cfm?cid=…
 *
 * Smart actions:
 * - Clearly wrong vs ground truth → apology (don't fight hopeless audits)
 * - Right / unclear → formal dispute discussion
 *
 *   npx ts-node scripts/dispute-eligible.ts
 */
import fs from "fs";
import path from "path";
import { chromium, Page } from "playwright";
import { config } from "../src/config";
import { navigateWithChallengeHandling } from "../src/verification";
import {
  loginWithCredentials,
  isLoggedIn,
  isOnFaceVerifyPage,
  waitForFaceVerifyClear,
} from "../src/session";

const AUDITS = "https://www.humanatic.com/pages/humfun/selection_all.cfm";
const BASE = "https://www.humanatic.com/pages/humfun/";
const OUT = path.resolve(process.cwd(), "data", "dispute-eligible-report.json");

const SORRY =
  "Sorry — after re-checking the recording I accept this audit correction and will improve on similar calls.";

const DISPUTE =
  "Respectfully disputing this penalty. I fully listened to the recording and selected according to category instructions. Please re-audit the audio and reconsider.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureSession(page: Page) {
  await navigateWithChallengeHandling(page, `${BASE}profile.cfm`);
  await sleep(1000);
  if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page, 90000);
  if (!(await isLoggedIn(page))) {
    await loginWithCredentials(page);
    await sleep(2000);
    if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page, 90000);
  }
}

async function recoverIfLogin(page: Page, wantUrl: string) {
  if (!/login\.cfm/i.test(page.url())) return;
  console.log("[dispute] session lost — re-login");
  await loginWithCredentials(page);
  await sleep(1500);
  if (isOnFaceVerifyPage(page)) await waitForFaceVerifyClear(page, 90000);
  await navigateWithChallengeHandling(page, wantUrl);
  await sleep(1500);
}

type AuditRow = {
  cid: string;
  date: string;
  time: string;
  earnings: string;
  selection: string;
  notes: string;
  href: string;
};

async function listEligible(page: Page): Promise<AuditRow[]> {
  await navigateWithChallengeHandling(page, AUDITS);
  await sleep(2000);
  await recoverIfLogin(page, AUDITS);
  return page.evaluate(() => {
    const out: AuditRow[] = [];
    for (const tr of Array.from(document.querySelectorAll("tr")).slice(1)) {
      const text = (tr.innerText || "").replace(/\s+/g, " ").trim();
      if (!/-\s*[\d.]+\s*¢/i.test(text)) continue;
      if (!/may be disputed/i.test(text)) continue;
      if (/not eligible for dispute yet/i.test(text)) continue;
      const a =
        (tr.querySelector("a[href*='selection_review']") as HTMLAnchorElement | null) ||
        (tr.querySelector("a[href*='cid=']") as HTMLAnchorElement | null) ||
        (Array.from(tr.querySelectorAll("a")).find((el) =>
          /dispute/i.test(el.textContent || ""),
        ) as HTMLAnchorElement | undefined) ||
        null;
      const hrefRaw = a?.getAttribute("href") || "";
      const cid = (hrefRaw.match(/cid=(\d+)/i) || text.match(/\b(600\d{7,})\b/) || [])[1] || "";
      if (!cid) continue;
      const cells = Array.from(tr.querySelectorAll("td")).map((td) =>
        (td.innerText || "").replace(/\s+/g, " ").trim(),
      );
      const href = hrefRaw.startsWith("http")
        ? hrefRaw
        : hrefRaw
          ? new URL(hrefRaw, location.href).href
          : `https://www.humanatic.com/pages/humfun/selection_review.cfm?cid=${cid}`;
      out.push({
        cid,
        date: cells[0] || "",
        time: cells[1] || "",
        earnings: cells[2] || "",
        selection: cells[4] || "",
        notes: cells[5] || "",
        href,
      });
    }
    return out;
  });
}

async function openReview(page: Page, cid: string): Promise<string> {
  const url = `${BASE}selection_review.cfm?cid=${cid}`;
  await navigateWithChallengeHandling(page, url);
  await sleep(2000);
  await recoverIfLogin(page, url);
  return ((await page.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ");
}

function judge(body: string, auditorSelection: string): {
  ourSelection: string;
  correctInbound: string;
  weWereWrong: boolean;
  weWereRight: boolean;
  alreadyCommented: boolean;
} {
  const ourSelection = (body.match(/selection:\s*(.+?)\s*selected on/i)?.[1] || "").trim();
  const correctInbound = (
    body.match(/Inbound\s*=\s*(.+?)(?:\s{2,}|Dealership|Service|Comments|Review History|$)/i)?.[1] ||
    auditorSelection ||
    ""
  )
    .trim()
    .slice(0, 160);

  const alreadyCommented =
    /does not yet have any comments/i.test(body) === false &&
    (/manuel|you said|comment posted|discussion/i.test(body) ||
      (body.match(/comment/gi) || []).length > 2);

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const our = norm(ourSelection);
  const correct = norm(correctInbound);
  let weWereWrong = false;
  let weWereRight = false;
  if (our && correct) {
    if (our === correct || correct.includes(our) || our.includes(correct)) weWereRight = true;
    else weWereWrong = true;
  } else if (/0%\s*accurate/i.test(body) && our) {
    weWereWrong = true;
  } else if (auditorSelection && our) {
    // Listing "Selection" is auditor correction on penalty rows
    const aud = norm(auditorSelection);
    if (aud && our && aud !== our && !aud.includes(our) && !our.includes(aud)) weWereWrong = true;
  }
  return { ourSelection, correctInbound, weWereWrong, weWereRight, alreadyCommented };
}

async function postDiscussion(page: Page, message: string): Promise<{ ok: boolean; detail: string }> {
  const start = page
    .locator('a:has-text("click here"), a:has-text("Click here"), a:has-text("start a discussion")')
    .first();
  if (await start.isVisible({ timeout: 2500 }).catch(() => false)) {
    await start.click().catch(() => undefined);
    await sleep(1500);
  }

  let ta = page.locator("textarea").first();
  if (!(await ta.isVisible({ timeout: 3000 }).catch(() => false))) {
    const commentBtn = page
      .locator('a:has-text("Comment"), button:has-text("Comment"), a:has-text("Add")')
      .first();
    if (await commentBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await commentBtn.click().catch(() => undefined);
      await sleep(1000);
    }
    ta = page.locator("textarea").first();
  }

  if (!(await ta.isVisible({ timeout: 3000 }).catch(() => false))) {
    return { ok: false, detail: "No comment textarea" };
  }

  await ta.fill(message);
  await sleep(400);

  const submit = page
    .locator(
      'input[type="submit"], button:has-text("Submit"), button:has-text("Post"), button:has-text("Send"), a:has-text("Submit"), input[value*="Submit" i]',
    )
    .first();
  if (await submit.isVisible({ timeout: 3000 }).catch(() => false)) {
    await submit.click().catch(() => undefined);
    await sleep(2200);
    return { ok: true, detail: "Posted discussion" };
  }

  await ta.press("Control+Enter").catch(() => undefined);
  await sleep(1500);
  const body = ((await page.locator("body").innerText().catch(() => "")) || "").toLowerCase();
  if (body.includes(message.slice(0, 32).toLowerCase())) {
    return { ok: true, detail: "Message visible on page" };
  }
  return { ok: false, detail: "Filled but submit unclear" };
}

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.chromeDebugPort}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No CDP context");
  const page = await context.newPage();

  await ensureSession(page);
  const eligible = await listEligible(page);
  console.log(`[dispute] eligible=${eligible.length}`);
  for (const e of eligible) {
    console.log(`  - ${e.date} ${e.time} ${e.earnings} cid=${e.cid}`);
  }

  const results: unknown[] = [];
  for (const audit of eligible) {
    try {
      const body = await openReview(page, audit.cid);
      if (/welcome to humanatic|log in/i.test(body) && body.length < 400) {
        await recoverIfLogin(page, `${BASE}selection_review.cfm?cid=${audit.cid}`);
      }
      const body2 = ((await page.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ");
      const verdict = judge(body2, audit.selection);
      console.log(
        `[dispute] cid=${audit.cid} our="${verdict.ourSelection.slice(0, 40)}" correct="${verdict.correctInbound.slice(0, 40)}" wrong=${verdict.weWereWrong} right=${verdict.weWereRight} commented=${verdict.alreadyCommented}`,
      );

      if (verdict.alreadyCommented) {
        results.push({ audit, verdict, action: "skip_already_commented" });
        continue;
      }

      // Fight only when we might be right; apologize when clearly wrong (better for account health)
      const action = verdict.weWereWrong && !verdict.weWereRight ? "sorry" : "dispute";
      const msg = action === "sorry" ? SORRY : DISPUTE;
      const post = await postDiscussion(page, msg);
      results.push({ audit, verdict, action, ...post });
      console.log(`[dispute] ${action} → ${post.detail}`);
      await sleep(800);
    } catch (e) {
      results.push({ audit, action: "error", detail: (e as Error).message });
      console.warn(`[dispute] error cid=${audit.cid}: ${(e as Error).message}`);
    }
  }

  await navigateWithChallengeHandling(page, AUDITS);
  await sleep(1500);
  const after = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("tr")).map((tr) =>
      (tr.innerText || "").replace(/\s+/g, " ").trim(),
    );
    return {
      stillMayDispute: rows.filter((t) => /may be disputed/i.test(t) && /-\s*[\d.]+\s*¢/i.test(t)).length,
      apologiesOrDisputed: rows
        .filter((t) => /disputed|mediation|discussion|pending/i.test(t))
        .slice(0, 12),
    };
  });

  const report = {
    scrapedAt: new Date().toISOString(),
    eligible: eligible.length,
    results,
    after,
    summary: {
      dispute: results.filter((r: any) => r.action === "dispute" && r.ok).length,
      sorry: results.filter((r: any) => r.action === "sorry" && r.ok).length,
      skipped: results.filter((r: any) => String(r.action).startsWith("skip")).length,
      failed: results.filter((r: any) => r.ok === false || r.action === "error").length,
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ summary: report.summary, after }, null, 2));
  console.log(`[dispute] wrote ${OUT}`);
  await page.close().catch(() => undefined);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
