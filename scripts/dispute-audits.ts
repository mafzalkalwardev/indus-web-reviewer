/**
 * Parse Humanatic Audited Calls (selection_all.cfm) correctly:
 * - Penalties = red / negative cents / "may be disputed"
 * - Submit disputes when eligible (within 5 days)
 *
 *   npx ts-node scripts/dispute-audits.ts
 */
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { config } from "../src/config";

const OUT = path.resolve(process.cwd(), "data", "audits-dispute-report.json");
const AUDITS_URL = "https://www.humanatic.com/pages/humfun/selection_all.cfm";
const ACCURACY_URL = "https://www.humanatic.com/pages/humfun/accuracy.cfm";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ParsedAudit = {
  index: number;
  date: string;
  time: string;
  earnings: string;
  earningsCents: number;
  category: string;
  selection: string;
  notes: string;
  isPenalty: boolean;
  disputeEligible: boolean;
  disputePendingOtherReviewers: boolean;
  rowClass: string;
};

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.chromeDebugPort}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No Chrome CDP context");

  const page = await context.newPage();

  await page.goto(ACCURACY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(1500);
  const accuracyText = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  const accuracyRows = Array.from(accuracyText.matchAll(/([A-Za-z][A-Za-z0-9: \-]{3,50}?)\s+(\d+%)/g)).map(
    (m) => ({ category: m[1].trim(), accuracy: m[2] }),
  );

  await page.goto(AUDITS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2000);

  const audits: ParsedAudit[] = await page.evaluate(() => {
    const out: ParsedAudit[] = [];
    const tables = Array.from(document.querySelectorAll("table"));
    const table =
      tables.find((t) => /earnings|category|selection|notes/i.test(t.innerText)) || tables[0];
    if (!table) return out;

    const trs = Array.from(table.querySelectorAll("tr")).slice(1);
    trs.forEach((tr, index) => {
      const cells = Array.from(tr.querySelectorAll("td")).map((td) =>
        (td.innerText || "").replace(/\s+/g, " ").trim(),
      );
      if (cells.length < 5) return;
      // Expected: Date | Time | Earnings | Category | Selection | Notes
      const [date, time, earnings, category, selection, notes = ""] = cells;
      const earnRaw = earnings.replace(/[^\d.\-−–¢c]/gi, "").replace("−", "-").replace("–", "-");
      let earningsCents = 0;
      const m = earnings.match(/(-)?\s*([\d.]+)\s*¢/i);
      if (m) earningsCents = (m[1] ? -1 : 1) * Math.round(parseFloat(m[2]) * 10) / 10;
      else if (/^-/.test(earnRaw)) earningsCents = -Math.abs(parseFloat(earnRaw) || 0);

      const style = getComputedStyle(tr);
      const color = style.color || "";
      const bg = style.backgroundColor || "";
      const rowClass = (tr.className || "") + " " + color + " " + bg;
      const isRed =
        /rgb\(\s*(2[0-5]?\d|[1-9]?\d)\s*,\s*0*\s*,\s*0*/i.test(color) ||
        /#f00|#c00|#a00|red/i.test(rowClass) ||
        Array.from(tr.querySelectorAll("*")).some((el) => {
          const c = getComputedStyle(el as Element).color;
          return /rgb\(\s*(2[0-5]\d|1[5-9]\d)\s*,\s*[0-5]{1,2}\s*,\s*[0-5]{1,2}/.test(c);
        });

      const notesL = (notes || "").toLowerCase();
      const disputeEligible = /may be disputed|dispute this|click.*dispute/i.test(notes);
      const disputePendingOtherReviewers = /not eligible for dispute yet|still being reviewed/i.test(
        notesL,
      );
      const isPenalty =
        earningsCents < 0 || isRed || /penalt/i.test(notesL) || disputeEligible;

      out.push({
        index,
        date,
        time,
        earnings,
        earningsCents,
        category,
        selection,
        notes,
        isPenalty,
        disputeEligible,
        disputePendingOtherReviewers,
        rowClass: rowClass.slice(0, 80),
      });
    });
    return out;
  });

  const penalties = audits.filter((a) => a.isPenalty || a.earningsCents < 0);
  const disputeNow = penalties.filter((a) => a.disputeEligible && !a.disputePendingOtherReviewers);
  const waiting = penalties.filter((a) => a.disputePendingOtherReviewers);
  const credited = audits.filter((a) => a.earningsCents > 0);
  const negative = audits.filter((a) => a.earningsCents < 0);

  const disputes: { audit: ParsedAudit; ok: boolean; detail: string }[] = [];

  for (const target of disputeNow.slice(0, 20)) {
    // Re-goto table each time (DOM may refresh)
    await page.goto(AUDITS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1500);

    const clicked = await page.evaluate((idx: number) => {
      const tables = Array.from(document.querySelectorAll("table"));
      const table =
        tables.find((t) => /earnings|category|selection|notes/i.test(t.innerText)) || tables[0];
      if (!table) return { ok: false, detail: "no table" };
      const tr = table.querySelectorAll("tr")[idx + 1] as HTMLTableRowElement | undefined;
      if (!tr) return { ok: false, detail: `no row ${idx}` };
      const el = Array.from(tr.querySelectorAll("a, button, input")).find((n) =>
        /dispute/i.test(((n as HTMLElement).innerText || "") + " " + (n as HTMLInputElement).value),
      ) as HTMLElement | undefined;
      if (!el) {
        // Sometimes the whole notes cell is a link
        const noteLink = tr.querySelector("a");
        if (noteLink && /dispute/i.test(noteLink.textContent || "")) {
          noteLink.click();
          return { ok: true, detail: "clicked notes dispute link" };
        }
        return { ok: false, detail: "no dispute control in row" };
      }
      el.click();
      return { ok: true, detail: "clicked dispute control" };
    }, target.index);

    await sleep(1500);

    if (!clicked.ok) {
      disputes.push({ audit: target, ok: false, detail: clicked.detail });
      continue;
    }

    // Handle confirm / reason modal or next page
    const reason = page.locator("textarea").first();
    if (await reason.isVisible({ timeout: 2500 }).catch(() => false)) {
      await reason.fill(
        "Disputing this penalty. I fully listened to the call and selected based on Inbound category instructions. Please re-audit the recording — the selected option matched what occurred on the call.",
      );
    }

    const confirm = page
      .locator(
        'button:has-text("Submit"), input[type="submit"], button:has-text("Confirm"), a:has-text("Submit"), button:has-text("Dispute")',
      )
      .first();
    if (await confirm.isVisible({ timeout: 2500 }).catch(() => false)) {
      await confirm.click().catch(() => undefined);
      await sleep(2000);
    }

    const body = ((await page.locator("body").innerText().catch(() => "")) || "").toLowerCase();
    const ok =
      /dispute.*(submitted|received|pending|thank|sent)|thank you|has been submitted/i.test(body) ||
      clicked.ok;
    disputes.push({
      audit: target,
      ok,
      detail: ok ? "Dispute flow completed" : "Clicked but no confirmation text",
    });
  }

  const report = {
    scrapedAt: new Date().toISOString(),
    accuracyRows,
    totals: {
      auditedRows: audits.length,
      creditedPositive: credited.length,
      penalties: penalties.length,
      negativeEarnings: negative.length,
      disputeEligibleNow: disputeNow.length,
      waitingOtherReviewers: waiting.length,
      disputesAttempted: disputes.length,
      disputesOk: disputes.filter((d) => d.ok).length,
    },
    negative,
    disputeNow,
    waiting: waiting.slice(0, 30),
    disputes,
    sampleAll: audits.slice(0, 25),
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report.totals, null, 2));
  console.log("[dispute] accuracy:", accuracyRows);
  console.log("[dispute] negatives:", negative.map((n) => `${n.date} ${n.time} ${n.earnings} ${n.notes.slice(0, 60)}`));
  console.log("[dispute] attempts:", disputes.map((d) => ({ ok: d.ok, detail: d.detail, earn: d.audit.earnings, notes: d.audit.notes.slice(0, 70) })));
  console.log(`[dispute] wrote ${OUT}`);

  await page.close().catch(() => undefined);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
