/**
 * Post discussion replies on audited calls:
 * - If we were wrong vs Humanatic ground truth → short apology (do not dispute)
 * - If we were right → dispute / defend selection
 *
 *   npx ts-node scripts/audit-replies.ts
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
const OUT = path.resolve(process.cwd(), "data", "audit-replies.json");

const SORRY =
  "Sorry — I mis-reviewed this call. I accept the correct option and will not contest this audit.";

const DISPUTE =
  "Respectfully disputing this audit. After a full listen, my selection matches what happened on the call. Please re-review the recording.";

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

type AuditLink = {
  cid: string;
  date: string;
  time: string;
  earnings: string;
  negative: boolean;
  mayDispute: boolean;
  notEligibleYet: boolean;
  selection: string;
  notes: string;
  href: string;
};

async function listAudits(page: Page): Promise<AuditLink[]> {
  await navigateWithChallengeHandling(page, AUDITS);
  await sleep(2000);
  return page.evaluate(() => {
    const out: AuditLink[] = [];
    const trs = Array.from(document.querySelectorAll("tr")).slice(1);
    for (const tr of trs) {
      const text = (tr.innerText || "").replace(/\s+/g, " ").trim();
      if (text.length < 20) continue;
      const a = tr.querySelector("a[href*='selection_review']") as HTMLAnchorElement | null;
      const href = a?.getAttribute("href") || "";
      const cid = (href.match(/cid=(\d+)/i) || [])[1] || "";
      if (!cid && !/-\s*[\d.]+\s*¢/i.test(text)) continue;
      const cells = Array.from(tr.querySelectorAll("td")).map((td) =>
        (td.innerText || "").replace(/\s+/g, " ").trim(),
      );
      out.push({
        cid,
        date: cells[0] || "",
        time: cells[1] || "",
        earnings: cells[2] || "",
        negative: /-\s*[\d.]+\s*¢/i.test(text),
        mayDispute: /may be disputed/i.test(text),
        notEligibleYet: /not eligible for dispute yet/i.test(text),
        selection: cells[4] || "",
        notes: cells[5] || "",
        href: href.startsWith("http")
          ? href
          : href
            ? `https://www.humanatic.com/pages/humfun/${href.replace(/^\.\//, "")}`
            : "",
      });
    }
    return out.filter((r) => r.cid);
  });
}

type Verdict = {
  cid: string;
  ourSelection: string;
  correctInbound: string;
  weWereWrong: boolean;
  weWereRight: boolean;
  alreadyCommented: boolean;
  preview: string;
};

async function readVerdict(page: Page, cid: string): Promise<Verdict> {
  const url = `${BASE}selection_review.cfm?cid=${cid}`;
  await navigateWithChallengeHandling(page, url);
  await sleep(2000);
  if (/login\.cfm/i.test(page.url())) {
    await loginWithCredentials(page);
    await sleep(1500);
    await navigateWithChallengeHandling(page, url);
    await sleep(2000);
  }

  return page.evaluate((id) => {
    const body = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const inboundMatch = body.match(/Inbound\s*=\s*([^=\n]+?)(?:\s+[A-Z][a-z].*?=|$)/i);
    // Prefer explicit "Inbound = ..."
    let correctInbound = "";
    const m1 = body.match(/Inbound\s*=\s*(.+?)(?:\s{2,}|Dealership|Service|Comments|Review History|$)/i);
    if (m1) correctInbound = m1[1].trim().slice(0, 160);

    const hist = body.match(
      /selection:\s*(.+?)\s*selected on/i,
    );
    const ourSelection = (hist?.[1] || "").trim().slice(0, 160);

    const alreadyCommented = /manuel|you said|comment|discussion/i.test(body) &&
      !/does not yet have any comments/i.test(body);

    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const our = norm(ourSelection);
    const correct = norm(correctInbound);
    let weWereWrong = false;
    let weWereRight = false;
    if (our && correct) {
      if (our === correct || correct.includes(our) || our.includes(correct)) {
        weWereRight = true;
      } else {
        weWereWrong = true;
      }
    } else if (/0%\s*accurate/i.test(body) && our) {
      weWereWrong = true;
    }

    return {
      cid: id,
      ourSelection,
      correctInbound,
      weWereWrong,
      weWereRight,
      alreadyCommented,
      preview: body.slice(0, 500),
    };
  }, cid);
}

async function postDiscussion(page: Page, message: string): Promise<{ ok: boolean; detail: string }> {
  // "click here" to start discussion
  const start = page.locator('a:has-text("click here"), a:has-text("Click here"), a:has-text("start a discussion")').first();
  if (await start.isVisible({ timeout: 3000 }).catch(() => false)) {
    await start.click().catch(() => undefined);
    await sleep(1500);
  }

  const ta = page.locator("textarea").first();
  if (!(await ta.isVisible({ timeout: 4000 }).catch(() => false))) {
    // Try Comment button
    const commentBtn = page.locator('a:has-text("Comment"), button:has-text("Comment"), a:has-text("Add")').first();
    if (await commentBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await commentBtn.click().catch(() => undefined);
      await sleep(1000);
    }
  }

  if (!(await ta.isVisible({ timeout: 3000 }).catch(() => false))) {
    return { ok: false, detail: "No comment textarea found" };
  }

  await ta.fill(message);
  await sleep(400);

  const submit = page
    .locator(
      'input[type="submit"], button:has-text("Submit"), button:has-text("Post"), button:has-text("Send"), a:has-text("Submit")',
    )
    .first();
  if (await submit.isVisible({ timeout: 3000 }).catch(() => false)) {
    await submit.click().catch(() => undefined);
    await sleep(2000);
    return { ok: true, detail: "Posted discussion reply" };
  }

  // Some forms submit on Enter / named buttons
  await ta.press("Control+Enter").catch(() => undefined);
  await sleep(1500);
  const body = ((await page.locator("body").innerText().catch(() => "")) || "").toLowerCase();
  if (body.includes(message.slice(0, 40).toLowerCase())) {
    return { ok: true, detail: "Message visible on page" };
  }
  return { ok: false, detail: "Filled textarea but could not find submit" };
}

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.chromeDebugPort}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No CDP context — is worker Chrome running?");
  const page = await context.newPage();

  await ensureSession(page);
  const audits = await listAudits(page);

  // Prioritize negatives + dispute-eligible; also any linked cid from penalties
  const targets = audits.filter((a) => a.negative || a.mayDispute);
  const unique = new Map<string, AuditLink>();
  for (const t of targets) {
    if (t.cid) unique.set(t.cid, t);
  }

  const results: unknown[] = [];

  for (const audit of unique.values()) {
    console.log(`[audit] cid=${audit.cid} earn=${audit.earnings} mayDispute=${audit.mayDispute}`);
    try {
      const verdict = await readVerdict(page, audit.cid);
      console.log(
        `[audit] our="${verdict.ourSelection.slice(0, 60)}" correct="${verdict.correctInbound.slice(0, 60)}" wrong=${verdict.weWereWrong} right=${verdict.weWereRight}`,
      );

      if (verdict.alreadyCommented && !verdict.weWereRight) {
        results.push({ audit, verdict, action: "skip_already_commented" });
        continue;
      }

      if (verdict.weWereWrong || (!verdict.weWereRight && /0%\s*accurate/i.test(verdict.preview))) {
        const post = await postDiscussion(page, SORRY);
        results.push({ audit, verdict, action: "sorry", ...post });
        continue;
      }

      if (verdict.weWereRight) {
        const post = await postDiscussion(page, DISPUTE);
        results.push({ audit, verdict, action: "dispute", ...post });
        continue;
      }

      results.push({ audit, verdict, action: "skip_unclear" });
    } catch (e) {
      results.push({ audit, action: "error", detail: (e as Error).message });
    }
  }

  const report = {
    scrapedAt: new Date().toISOString(),
    auditedLinked: audits.length,
    targeted: unique.size,
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ targeted: unique.size, results }, null, 2));
  console.log(`[audit] wrote ${OUT}`);
  await page.close().catch(() => undefined);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
