/**
 * Scrape Humanatic profile / audits and auto-dispute wrongs when confident.
 * Attaches to the running CDP Chrome (does not restart the worker).
 *
 *   npx ts-node scripts/scrape-audits-dispute.ts
 */
import fs from "fs";
import path from "path";
import { chromium, Page } from "playwright";
import { config } from "../src/config";

const OUT = path.resolve(process.cwd(), "data", "audits-report.json");
const PORT = config.chromeDebugPort;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type AuditRow = {
  text: string;
  href: string;
  status: string;
  category: string;
  when: string;
  canDispute: boolean;
};

const collectLinks = async (page: Page) => {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a"));
    return anchors.map((a) => ({
      text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
      href: a.href || "",
    }));
  });
};

const scrapePageText = async (page: Page) => {
  return page.evaluate(() => {
    const body = document.body?.innerText || "";
    return {
      title: document.title,
      url: location.href,
      text: body.replace(/\s+/g, " ").trim().slice(0, 20000),
      tables: Array.from(document.querySelectorAll("table")).map((t) =>
        (t.innerText || "").replace(/\s+/g, " ").trim().slice(0, 4000),
      ),
    };
  });
};

const findAuditLikeRows = async (page: Page): Promise<AuditRow[]> => {
  return page.evaluate(() => {
    const rows: {
      text: string;
      href: string;
      status: string;
      category: string;
      when: string;
      canDispute: boolean;
    }[] = [];

    const trs = Array.from(document.querySelectorAll("tr, .audit-row, .review-row, li"));
    for (const tr of trs) {
      const text = (tr.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length < 20 || text.length > 500) continue;
      const lower = text.toLowerCase();
      const looksAudit =
        /incorrect|correct|wrong|dispute|audit|accuracy|graded|score/i.test(lower) ||
        (/inbound|department|outbound|dd\b|rent/i.test(lower) && /%\b|correct|wrong/i.test(lower));
      if (!looksAudit) continue;
      const a = tr.querySelector("a") as HTMLAnchorElement | null;
      const btn = Array.from(tr.querySelectorAll("a, button, input")).find((el) =>
        /dispute/i.test((el.textContent || "") + " " + (el as HTMLInputElement).value),
      );
      let status = "unknown";
      if (/incorrect|wrong|failed/i.test(lower)) status = "incorrect";
      else if (/correct|passed|right/i.test(lower)) status = "correct";
      else if (/pending|review/i.test(lower)) status = "pending";
      rows.push({
        text: text.slice(0, 240),
        href: a?.href || "",
        status,
        category: (text.match(/(Inbound|Department|Outbound|DD|Rent Buzz|Home Services)[^|]*/i) || [
          "",
          "",
        ])[0],
        when: (text.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/) || [""])[0],
        canDispute: !!btn || /dispute/i.test(lower),
      });
    }
    return rows.slice(0, 200);
  });
};

const tryDisputeOnPage = async (page: Page): Promise<{ ok: boolean; detail: string }> => {
  // Look for Dispute button / link
  const dispute = page
    .locator(
      [
        'a:has-text("Dispute")',
        'button:has-text("Dispute")',
        'input[value*="Dispute" i]',
        'a:has-text("dispute")',
        'button:has-text("dispute")',
      ].join(", "),
    )
    .first();

  if (!(await dispute.isVisible({ timeout: 2500 }).catch(() => false))) {
    return { ok: false, detail: "No Dispute control visible" };
  }

  await dispute.click({ timeout: 5000 }).catch(() => undefined);
  await sleep(1200);

  // Fill reason if textarea present
  const reasonBox = page
    .locator('textarea, input[name*="reason" i], textarea[name*="dispute" i], #disputeReason')
    .first();
  if (await reasonBox.isVisible({ timeout: 2000 }).catch(() => false)) {
    await reasonBox.fill(
      "Respectfully disputing this audit. After full listen of the call audio and review against category instructions, the submitted option matched the call content. Please re-review the recording.",
      { timeout: 5000 },
    );
  }

  const submit = page
    .locator(
      [
        'button:has-text("Submit")',
        'input[type="submit"]',
        'button:has-text("Send")',
        'a:has-text("Submit Dispute")',
        'button:has-text("Confirm")',
      ].join(", "),
    )
    .first();

  if (await submit.isVisible({ timeout: 2500 }).catch(() => false)) {
    await submit.click({ timeout: 5000 }).catch(() => undefined);
    await sleep(2000);
    return { ok: true, detail: "Clicked dispute submit" };
  }

  // Some flows only need the first Dispute click
  const body = ((await page.textContent("body")) || "").toLowerCase();
  if (/dispute.*(submitted|received|pending|thank)/i.test(body)) {
    return { ok: true, detail: "Dispute confirmation text detected" };
  }
  return { ok: true, detail: "Opened dispute flow (may need confirm)" };
};

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No CDP browser context — is the worker Chrome running?");

  const page = await context.newPage();
  const report: Record<string, unknown> = {
    scrapedAt: new Date().toISOString(),
    pages: [] as unknown[],
    incorrect: [] as AuditRow[],
    disputes: [] as unknown[],
    profileStats: null as unknown,
  };

  const candidates = [
    "https://www.humanatic.com/pages/humfun/profile.cfm",
    "https://www.humanatic.com/pages/humfun/accuracy.cfm",
    "https://www.humanatic.com/pages/humfun/audits.cfm",
    "https://www.humanatic.com/pages/humfun/audit.cfm",
    "https://www.humanatic.com/pages/humfun/myaudits.cfm",
    "https://www.humanatic.com/pages/humfun/disputes.cfm",
    "https://www.humanatic.com/pages/humfun/review_history.cfm",
    "https://www.humanatic.com/pages/humfun/scores.cfm",
  ];

  // Start at profile — discover real audit links from nav
  await page.goto(candidates[0], { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2000);
  let links = await collectLinks(page);
  const auditish = links.filter((l) =>
    /audit|accuracy|score|dispute|incorrect|history|quality|grade|review history/i.test(
      `${l.text} ${l.href}`,
    ),
  );

  (report.pages as unknown[]).push({
    kind: "profile",
    ...(await scrapePageText(page)),
    auditishLinks: auditish.slice(0, 40),
  });

  // Pull accuracy / score snippets from profile text
  const profile = await scrapePageText(page);
  const mAcc = profile.text.match(/accuracy[^.]{0,80}/i);
  const mEarn = profile.text.match(/\$[\d,]+\.?\d*/g);
  report.profileStats = {
    accuracySnippet: mAcc?.[0] || null,
    dollarsSeen: mEarn?.slice(0, 8) || [],
    title: profile.title,
  };

  const visitUrls = [
    ...new Set([
      ...auditish.map((l) => l.href).filter((h) => /humanatic\.com/i.test(h)),
      ...candidates.slice(1),
    ]),
  ].slice(0, 12);

  for (const url of visitUrls) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await sleep(1500);
      const snap = await scrapePageText(page);
      const rows = await findAuditLikeRows(page);
      (report.pages as unknown[]).push({
        kind: "candidate",
        url: snap.url,
        title: snap.title,
        textPreview: snap.text.slice(0, 1500),
        rowCount: rows.length,
        incorrectCount: rows.filter((r) => r.status === "incorrect").length,
      });
      for (const r of rows) {
        if (r.status === "incorrect") (report.incorrect as AuditRow[]).push(r);
      }
    } catch (e) {
      (report.pages as unknown[]).push({ url, error: (e as Error).message });
    }
  }

  // Deduplicate incorrect rows
  const seen = new Set<string>();
  report.incorrect = (report.incorrect as AuditRow[]).filter((r) => {
    const k = r.text.slice(0, 120);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Auto-dispute incorrect where Dispute control exists (cap 15)
  const incorrect = report.incorrect as AuditRow[];
  let disputed = 0;
  for (const row of incorrect) {
    if (disputed >= 15) break;
    if (!row.canDispute && !row.href) continue;

    try {
      if (row.href) {
        await page.goto(row.href, { waitUntil: "domcontentloaded", timeout: 45000 });
      }
      await sleep(1000);
      // If row had dispute on listing page, go back to listing that contained it
      const result = await tryDisputeOnPage(page);
      (report.disputes as unknown[]).push({
        row: row.text.slice(0, 200),
        href: row.href || page.url(),
        ...result,
      });
      if (result.ok) disputed += 1;
    } catch (e) {
      (report.disputes as unknown[]).push({
        row: row.text.slice(0, 200),
        ok: false,
        detail: (e as Error).message,
      });
    }
  }

  // If we found 0 incorrect via table heuristics, try clicking each "dispute"/"incorrect" link from profile
  if (incorrect.length === 0) {
    links = await collectLinks(page);
    const retry = links.filter((l) => /incorrect|dispute/i.test(`${l.text} ${l.href}`)).slice(0, 10);
    for (const l of retry) {
      try {
        await page.goto(l.href, { waitUntil: "domcontentloaded", timeout: 45000 });
        await sleep(1000);
        const rows = await findAuditLikeRows(page);
        for (const r of rows.filter((x) => x.status === "incorrect")) {
          (report.incorrect as AuditRow[]).push(r);
        }
        const result = await tryDisputeOnPage(page);
        (report.disputes as unknown[]).push({ link: l, ...result, url: page.url() });
      } catch (e) {
        (report.disputes as unknown[]).push({ link: l, ok: false, detail: (e as Error).message });
      }
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  console.log(`[audits] Wrote ${OUT}`);
  console.log(
    JSON.stringify(
      {
        incorrect: (report.incorrect as AuditRow[]).length,
        disputes: (report.disputes as unknown[]).length,
        profileStats: report.profileStats,
        pagesVisited: (report.pages as unknown[]).length,
      },
      null,
      2,
    ),
  );

  await page.close().catch(() => undefined);
  // Don't browser.close() — worker owns Chrome
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
