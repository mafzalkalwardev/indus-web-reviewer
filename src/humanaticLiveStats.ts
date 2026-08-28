/**
 * Live Humanatic account mirror — earnings / accuracy / leaderboard
 * scraped from the same pages the site shows the reviewer.
 */
import fs from "fs";
import path from "path";
import { Page } from "playwright";
import { navigateWithChallengeHandling } from "./verification";
import { ensureClearOfBreakRoom } from "./breakRoom";

const dataDir = path.resolve(process.cwd(), "data");
const livePath = path.join(dataDir, "humanatic-live.json");
const BASE = "https://www.humanatic.com/pages/humfun/";

export type LeaderboardRow = {
  rank: number;
  name: string;
  scoreLabel: string;
  scoreCents: number | null;
  isYou: boolean;
};

export type CategoryAccuracy = {
  name: string;
  accuracyPct: number | null;
  raw: string;
};

export type HumanaticLiveSnapshot = {
  scrapedAt: string;
  profileName: string;
  /** Exact labels as shown on Humanatic when possible */
  todayEarningsLabel: string;
  todayEarningsCents: number | null;
  balanceLabel: string;
  balanceCents: number | null;
  periodLabel: string;
  accuracyOverallLabel: string;
  accuracyOverallPct: number | null;
  categoryAccuracy: CategoryAccuracy[];
  leaderboard: LeaderboardRow[];
  yourRank: number | null;
  leaderboardTitle: string;
  pagesVisited: string[];
  rawHints: string[];
  goalDollars: number;
  goalProgressPct: number;
  goalTip: string;
};

const emptySnap = (): HumanaticLiveSnapshot => ({
  scrapedAt: "",
  profileName: "",
  todayEarningsLabel: "—",
  todayEarningsCents: null,
  balanceLabel: "—",
  balanceCents: null,
  periodLabel: "",
  accuracyOverallLabel: "—",
  accuracyOverallPct: null,
  categoryAccuracy: [],
  leaderboard: [],
  yourRank: null,
  leaderboardTitle: "Leaderboard",
  pagesVisited: [],
  rawHints: [],
  goalDollars: 100,
  goalProgressPct: 0,
  goalTip: "Waiting for first Humanatic earnings scrape…",
});

let mem: HumanaticLiveSnapshot | null = null;

const centsLabel = (c: number | null): string => {
  if (c == null || !Number.isFinite(c)) return "—";
  if (Math.abs(c) >= 100) return `$${(c / 100).toFixed(2)}`;
  return `${Number(c.toFixed(2))}¢`;
};

export const loadHumanaticLive = (opts: { fresh?: boolean } = {}): HumanaticLiveSnapshot => {
  if (!opts.fresh && mem && mem.scrapedAt) return mem;
  try {
    if (fs.existsSync(livePath)) {
      mem = { ...emptySnap(), ...(JSON.parse(fs.readFileSync(livePath, "utf8")) as HumanaticLiveSnapshot) };
      return mem;
    }
  } catch {
    /* ignore */
  }
  return mem || emptySnap();
};

export const saveHumanaticLive = (snap: HumanaticLiveSnapshot): void => {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  mem = snap;
  fs.writeFileSync(livePath, JSON.stringify(snap, null, 2), "utf8");
};

const applyGoal = (snap: HumanaticLiveSnapshot): HumanaticLiveSnapshot => {
  const goal = snap.goalDollars || 100;
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const day = new Date().getDate();
  const needPerDay = goal / daysInMonth;
  const todayDollars = snap.todayEarningsCents != null ? snap.todayEarningsCents / 100 : 0;
  // Project this month from today's pace (site "Unverified today")
  const projectedMonth = todayDollars * daysInMonth;
  snap.goalProgressPct = Math.max(0, Math.min(100, Math.round((projectedMonth / goal) * 1000) / 10));
  const pace =
    todayDollars >= needPerDay * 0.85
      ? "on pace"
      : todayDollars >= needPerDay * 0.45
        ? "behind"
        : "far behind";
  const rankBit =
    snap.yourRank != null
      ? `Leaderboard #${snap.yourRank}.`
      : snap.leaderboard.length
        ? "Not on visible leaderboard yet — push accurate volume."
        : "Leaderboard pending scrape.";
  const balBit = snap.balanceLabel !== "—" ? `available ${snap.balanceLabel}` : "";
  snap.goalTip = `$${goal}/mo · ${pace} · need ~$${needPerDay.toFixed(2)}/day · today ${snap.todayEarningsLabel}${balBit ? ` · ${balBit}` : ""} · day ${day}/${daysInMonth} · ${rankBit}`;
  return snap;
};

/** Parse Humanatic money into cents (¢). $1.00 → 100 ; 1.3¢ → 1.3 */
const parseMoneyToCents = (raw: string): number | null => {
  const s = String(raw || "");
  const dollar = s.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (dollar) return Math.round(parseFloat(dollar[1].replace(/,/g, "")) * 100 * 10) / 10;
  const cent = s.match(/(-)?\s*([\d.]+)\s*¢/);
  if (cent) return (cent[1] ? -1 : 1) * parseFloat(cent[2]);
  return null;
};

type PageExtract = {
  url: string;
  title: string;
  bodyText: string;
  tables: string[][];
  links: Array<{ text: string; href: string }>;
};

async function extractPage(page: Page): Promise<PageExtract> {
  return page.evaluate(() => {
    const tables: string[][] = [];
    for (const table of Array.from(document.querySelectorAll("table"))) {
      for (const tr of Array.from(table.querySelectorAll("tr"))) {
        const cells = Array.from(tr.querySelectorAll("th,td")).map((c) =>
          (c.textContent || "").replace(/\s+/g, " ").trim(),
        );
        if (cells.some(Boolean)) tables.push(cells);
      }
    }
    const links = Array.from(document.querySelectorAll("a")).map((a) => ({
      text: (a.textContent || "").replace(/\s+/g, " ").trim(),
      href: (a as HTMLAnchorElement).href || "",
    }));
    return {
      url: location.href,
      title: document.title || "",
      bodyText: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 20000),
      tables,
      links,
    };
  });
}

async function softGoto(page: Page, url: string): Promise<boolean> {
  try {
    await navigateWithChallengeHandling(page, url);
    await new Promise((r) => setTimeout(r, 1200));
    await ensureClearOfBreakRoom(page).catch(() => undefined);
    return true;
  } catch (e) {
    console.warn(`[live] goto failed ${url}: ${(e as Error).message}`);
    return false;
  }
}

/** Map category name → accuracy % from last scrape (for growth pick). */
export const accuracyLookupFromLive = (): Map<string, number> => {
  const map = new Map<string, number>();
  const snap = loadHumanaticLive();
  for (const row of snap.categoryAccuracy) {
    if (row.accuracyPct == null) continue;
    const key = row.name.toLowerCase().replace(/\s+/g, " ").trim();
    map.set(key, row.accuracyPct);
    // Short alias (first token) for fuzzy match
    const first = key.split(/[:\-]/)[0]?.trim();
    if (first && first.length > 3) map.set(first, row.accuracyPct);
  }
  return map;
};

/**
 * Scrape Earnings, Accuracy, Leaderboard (and Profile) without leaving a live call.
 * Caller must ensure we're not mid-review.cfm. Returns to returnUrl when possible.
 */
export async function scrapeHumanaticLiveStats(
  page: Page,
  opts: { returnUrl?: string } = {},
): Promise<HumanaticLiveSnapshot> {
  const snap = emptySnap();
  snap.scrapedAt = new Date().toISOString();
  snap.goalDollars = 100;
  const returnUrl = opts.returnUrl || page.url();

  const here = page.url().toLowerCase();
  if (here.includes("review.cfm")) {
    console.warn("[live] Skip scrape — live review in progress");
    return loadHumanaticLive();
  }

  // Discover nav links from profile first
  await softGoto(page, `${BASE}profile.cfm`);
  const profile = await extractPage(page);
  snap.pagesVisited.push(profile.url);
  // Profile page opens with "Profile ? First Last" then nav noise
  const nameMatch =
    profile.bodyText.match(/Profile\s*[?·\-–—]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/) ||
    profile.title.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*[-|]/);
  if (nameMatch) {
    snap.profileName = nameMatch[1].trim();
  } else {
    const m2 = profile.bodyText.match(/\b(Manuel Hick|[A-Z][a-z]+ [A-Z][a-z]+)\b/);
    if (m2 && !/Review|Calls|Earnings|Accuracy|Leaderboard/i.test(m2[1])) {
      snap.profileName = m2[1];
    }
  }

  const linkByHref = (re: RegExp) => profile.links.find((l) => re.test(l.href))?.href || "";
  const linkByExactText = (label: string) =>
    profile.links.find((l) => l.text.trim().toLowerCase() === label.toLowerCase() && /\.cfm/i.test(l.href))
      ?.href || "";

  const earningsUrl =
    linkByHref(/\/(?:earnings|payout)\.cfm/i) ||
    linkByExactText("Earnings") ||
    `${BASE}payout.cfm`;
  const accuracyUrl =
    linkByHref(/\/accuracy\.cfm/i) || linkByExactText("Accuracy") || `${BASE}accuracy.cfm`;
  const leaderboardUrl =
    linkByHref(/\/leaderboard\.cfm/i) || linkByExactText("Leaderboard") || `${BASE}leaderboard.cfm`;

  // —— Earnings (Humanatic "Earnings" nav → payout.cfm) ——
  if (await softGoto(page, earningsUrl)) {
    const earn = await extractPage(page);
    snap.pagesVisited.push(earn.url);
    snap.rawHints.push(earn.bodyText.slice(0, 500));

    // Live page copy (Aug 2026):
    // "Lifetime earnings: $8.96 Available earnings: $8.01 Unverified yesterday: $0.79 Unverified today: $0.16"
    const todayM =
      earn.bodyText.match(/unverified\s*today\s*:\s*([$\d.,]+)/i) ||
      earn.bodyText.match(/today'?s?\s*earnings[^0-9$¢]*([$\d.,]+\s*¢?|[\d.]+\s*¢)/i) ||
      earn.bodyText.match(/earnings\s*(?:today|for today)[^0-9$¢]*([$\d.,]+\s*¢?|[\d.]+\s*¢)/i);
    const balM =
      earn.bodyText.match(/available\s*earnings\s*:\s*([$\d.,]+)/i) ||
      earn.bodyText.match(/(?:available\s*)?balance[^0-9$¢]*([$\d.,]+\s*¢?|[\d.]+\s*¢)/i) ||
      earn.bodyText.match(/unpaid[^0-9$¢]*([$\d.,]+\s*¢?|[\d.]+\s*¢)/i);
    const lifeM = earn.bodyText.match(/lifetime\s*earnings\s*:\s*([$\d.,]+)/i);
    const ydayM = earn.bodyText.match(/unverified\s*yesterday\s*:\s*([$\d.,]+)/i);

    if (todayM) {
      snap.todayEarningsLabel = todayM[1].trim();
      snap.todayEarningsCents = parseMoneyToCents(todayM[1]);
    }
    if (balM) {
      snap.balanceLabel = balM[1].trim();
      snap.balanceCents = parseMoneyToCents(balM[1]);
    }
    const bits: string[] = [];
    if (lifeM) bits.push(`Lifetime ${lifeM[1].trim()}`);
    if (ydayM) bits.push(`Yesterday ${ydayM[1].trim()}`);
    if (bits.length) snap.periodLabel = bits.join(" · ");
  }

  // —— Accuracy ——
  if (await softGoto(page, accuracyUrl)) {
    const acc = await extractPage(page);
    snap.pagesVisited.push(acc.url);
    const cats: CategoryAccuracy[] = [];
    for (const row of acc.tables) {
      if (row.length < 2) continue;
      if (/categor/i.test(row[0]) && /accuracy/i.test(row[1] || "")) continue;
      const pctM = (row[1] || row.join(" ")).match(/([\d.]+)\s*%/);
      if (!pctM && !/inbound|department|rent|outbound|home|dealership/i.test(row[0])) continue;
      cats.push({
        name: row[0],
        accuracyPct: pctM ? parseFloat(pctM[1]) : null,
        raw: row.join(" | "),
      });
    }
    // Fallback parse body "Inbound 0%" (Humanatic Category Accuracy page)
    if (!cats.length) {
      const chunk = acc.bodyText.replace(/^[\s\S]*?Categories\s+Accuracy\s*/i, "");
      const re = /([A-Za-z][A-Za-z0-9 :&\-]{2,60}?)\s+([\d.]+)\s*%/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(chunk || acc.bodyText))) {
        if (/how accuracy|system calculates|selected at random|visit our faq|categories/i.test(m[1]))
          continue;
        cats.push({ name: m[1].trim(), accuracyPct: parseFloat(m[2]), raw: m[0] });
      }
    }
    snap.categoryAccuracy = cats.slice(0, 20);
    const vals = cats.map((c) => c.accuracyPct).filter((v): v is number => v != null && v > 0);
    if (vals.length) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      snap.accuracyOverallPct = Math.round(avg * 10) / 10;
      snap.accuracyOverallLabel = `${snap.accuracyOverallPct}%`;
    } else if (/([\d.]+)\s*%/.test(acc.bodyText)) {
      // all zeros — still show
      snap.accuracyOverallLabel = "0%";
      snap.accuracyOverallPct = 0;
    }
  }

  // —— Leaderboard ——
  if (await softGoto(page, leaderboardUrl)) {
    const lb = await extractPage(page);
    snap.pagesVisited.push(lb.url);
    snap.leaderboardTitle = /leaderboard/i.test(lb.title) ? lb.title.replace(/\s*-\s*Humanatic/i, "").trim() : "Leaderboard";
    const youName = (snap.profileName || "").toLowerCase();
    const rows: LeaderboardRow[] = [];
    let rank = 0;
    for (const row of lb.tables) {
      const text = row.join(" ").trim();
      if (!text || /rank|name|reviewer|earnings|score/i.test(text) && rank === 0 && rows.length === 0) {
        if (/rank|name|reviewer/i.test(text)) continue;
      }
      const rankCell = row.find((c) => /^\d{1,3}$/.test(c));
      const moneyCell = row.find((c) => /[\d.]+\s*¢/.test(c) || /\$\s*[\d.]+/.test(c));
      const nameCell =
        row.find((c) => /[A-Za-z]{2,}/.test(c) && !/^\d+$/.test(c) && !/¢|\$/.test(c)) || "";
      if (!nameCell && !moneyCell) continue;
      rank += 1;
      const r = rankCell ? Number(rankCell) : rank;
      const isYou =
        (!!youName && nameCell.toLowerCase().includes(youName.split(" ")[0] || "___")) ||
        /you|me|\*$/i.test(nameCell);
      rows.push({
        rank: r,
        name: nameCell || `Reviewer ${r}`,
        scoreLabel: moneyCell || row[row.length - 1] || "",
        scoreCents: moneyCell ? parseMoneyToCents(moneyCell) : null,
        isYou,
      });
    }
    // Body fallback: "#1 Jane $12.50"
    if (!rows.length) {
      const re = /#?\s*(\d{1,3})[).\s]+([A-Za-z][A-Za-z0-9 .'_-]{1,40})\s+([$\d.,]+\s*¢?|[\d.]+\s*¢)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lb.bodyText))) {
        rows.push({
          rank: Number(m[1]),
          name: m[2].trim(),
          scoreLabel: m[3].trim(),
          scoreCents: parseMoneyToCents(m[3]),
          isYou: youName ? m[2].toLowerCase().includes(youName.split(" ")[0]) : false,
        });
      }
    }
    snap.leaderboard = rows.slice(0, 50);
    const me = rows.find((r) => r.isYou);
    snap.yourRank = me?.rank ?? null;
    if (!me && youName) {
      const fuzzy = rows.find((r) => r.name.toLowerCase().includes(youName.slice(0, 5)));
      if (fuzzy) {
        fuzzy.isYou = true;
        snap.yourRank = fuzzy.rank;
      }
    }
  }

  // Normalize labels
  if (snap.todayEarningsCents != null && snap.todayEarningsLabel === "—") {
    snap.todayEarningsLabel = centsLabel(snap.todayEarningsCents);
  }
  if (snap.balanceCents != null && snap.balanceLabel === "—") {
    snap.balanceLabel = centsLabel(snap.balanceCents);
  }

  applyGoal(snap);
  saveHumanaticLive(snap);
  console.log(
    `[live] Humanatic mirror: today=${snap.todayEarningsLabel} bal=${snap.balanceLabel} acc=${snap.accuracyOverallLabel} rank=${snap.yourRank ?? "—"} lb=${snap.leaderboard.length}`,
  );

  // Return to prior queue page so TM / wait loop resume quietly
  const back = (returnUrl || "").toLowerCase();
  if (back && !back.includes("earnings") && !back.includes("accuracy") && !back.includes("leaderboard") && !back.includes("profile.cfm")) {
    await softGoto(page, returnUrl);
  } else if (back.includes("nocalls")) {
    await softGoto(page, returnUrl);
  }

  return snap;
}

export const humanaticLiveForApi = () => applyGoal(loadHumanaticLive({ fresh: true }));
