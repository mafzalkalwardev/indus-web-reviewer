/**
 * Live category inventory from Category List (English - N counts + payout ¢).
 * Discovers unknown/unlocked categories for growth mode.
 */
import { Page } from "playwright";
import { HUMANATIC_CATEGORIES, CATEGORY_ID_REFERENCE } from "./categories";
import { loadDashboardCategories } from "./storage";
import { upsertGrowthRows, pickGrowthCategory, InventoryForGrowth } from "./growthCatalog";

export type CategoryInventory = {
  categoryId: number;
  name: string;
  available: number;
  availableLabel: string;
  status: string;
  payoutCents: number;
  payoutLabel: string;
};

/** Parse "English - 4" / "4" / "English: 4" → number. */
export function parseAvailableCount(raw: string | undefined | null): number {
  if (!raw) return 0;
  const s = String(raw).trim();
  const m =
    s.match(/(?:english|calls?|available)[^\d]*(\d+)/i) ||
    s.match(/(\d+)\s*$/) ||
    s.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

export function parsePayoutCents(raw: string | undefined | null): number {
  if (!raw) return 0;
  const m = String(raw).replace(/,/g, "").match(/([\d.]+)\s*¢/);
  return m ? Number(m[1]) : 0;
}

/** Best known inventory from last scraped dashboard file (may be slightly stale). */
export function inventoryFromCache(): CategoryInventory[] {
  return loadDashboardCategories().map((c) => ({
    categoryId: c.id,
    name: c.name,
    available: parseAvailableCount(c.availableCalls),
    availableLabel: c.availableCalls || "",
    status: c.lastStatus || "",
    payoutCents: c.payoutCents || 0,
    payoutLabel: c.payoutLabel || "",
  }));
}

/** Scrape Category List DOM for live availability + payouts + unknown cats. */
export async function scrapeLiveInventory(page: Page): Promise<CategoryInventory[]> {
  const known = [
    ...HUMANATIC_CATEGORIES.map((c) => ({ id: c.id, name: c.name })),
    ...CATEGORY_ID_REFERENCE.map((c) => ({ id: c.id, name: c.name })),
  ];

  const rows = await page.evaluate((knownCats) => {
    const out: Array<{
      categoryId: number;
      name: string;
      availableLabel: string;
      status: string;
      payoutLabel: string;
    }> = [];

    const pushRow = (partial: {
      categoryId: number;
      name: string;
      availableLabel: string;
      status: string;
      payoutLabel: string;
    }) => {
      if (!partial.categoryId) return;
      out.push(partial);
    };

    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        'a[href*="hcat_intro"], a[href*="category_selector"], a[href*="hcat="], a',
      ),
    );

    for (const a of anchors) {
      const href = a.href || "";
      const idMatch = href.match(/[?&](?:hcat|category)=(\d+)/i);
      if (!idMatch) continue;
      const categoryId = Number(idMatch[1]);
      const row =
        (a.closest("tr, .category-row, li, .card, .list-item, div") as HTMLElement | null) ||
        a.parentElement;
      const text = (row?.innerText || a.innerText || "").replace(/\s+/g, " ").trim();
      const avail =
        text.match(/English\s*[-:–]\s*\d+/i)?.[0] ||
        text.match(/(\d+)\s*calls?/i)?.[0] ||
        "";
      const payoutLabel = text.match(/[\d.]+\s*¢/)?.[0] || "";
      const status = /currently\s+unavailable/i.test(text)
        ? "unavailable"
        : /no\s*calls/i.test(text)
          ? "no_calls"
          : /review/i.test(text)
            ? "review"
            : "unknown";
      const name =
        text.split(/English|REVIEW|¢|\$/i)[0]?.trim().slice(0, 80) || `Category ${categoryId}`;
      pushRow({ categoryId, name, availableLabel: avail, status, payoutLabel });
    }

    // Table rows — discover by href OR known name OR any REVIEW + English line
    const rowEls = Array.from(
      document.querySelectorAll("tr, .category-row, .humfun-category, [class*='category']"),
    ) as HTMLElement[];
    for (const row of rowEls) {
      const text = (row.innerText || "").replace(/\s+/g, " ").trim();
      if (!text || text.length < 4) continue;
      const payoutLabel = text.match(/[\d.]+\s*¢/)?.[0] || "";
      const avail = text.match(/English\s*[-:–]\s*\d+/i)?.[0] || "";
      const countMatch = text.match(/English\s*[-:–]\s*(\d+)/i);
      const count = countMatch ? Number(countMatch[1]) : 0;
      const hasReview = /review\s*>?/i.test(text);
      if (!avail && !hasReview && !payoutLabel) continue;

      let categoryId = 0;
      const link = row.querySelector<HTMLAnchorElement>(
        'a[href*="hcat="], a[href*="category="], a[href*="hcat_intro"], a[href*="category_selector"]',
      );
      const idMatch = link?.href?.match(/[?&](?:hcat|category)=(\d+)/i);
      if (idMatch) categoryId = Number(idMatch[1]);

      if (!categoryId) {
        const knownHit = knownCats.find((c) => {
          const n = (c.name || "").toLowerCase();
          return n.length > 2 && text.toLowerCase().includes(n);
        });
        if (knownHit) categoryId = knownHit.id;
      }
      if (!categoryId) continue;

      const knownHit = knownCats.find((c) => c.id === categoryId);
      const name =
        knownHit?.name ||
        text.split(/English|REVIEW|¢|\$/i)[0]?.trim().slice(0, 80) ||
        `Category ${categoryId}`;

      pushRow({
        categoryId,
        name,
        availableLabel: avail || (hasReview ? `English - ${Math.max(count, 1)}` : ""),
        status: /currently\s+unavailable/i.test(text)
          ? "unavailable"
          : hasReview
            ? "review"
            : count > 0
              ? "review"
              : /no\s*calls/i.test(text)
                ? "no_calls"
                : "unknown",
        payoutLabel,
      });
    }

    const map = new Map<number, (typeof out)[0]>();
    for (const r of out) {
      const prev = map.get(r.categoryId);
      if (!prev) {
        map.set(r.categoryId, r);
        continue;
      }
      const prefer =
        (r.availableLabel && !prev.availableLabel) ||
        (r.payoutLabel && !prev.payoutLabel) ||
        (r.status === "review" && prev.status !== "review");
      if (prefer) map.set(r.categoryId, r);
    }
    return Array.from(map.values());
  }, known);

  const inventory: CategoryInventory[] = rows.map((r) => {
    const payoutCents = parsePayoutCents(r.payoutLabel);
    const available = Math.max(
      parseAvailableCount(r.availableLabel),
      r.status === "review" ? 1 : 0,
    );
    return {
      categoryId: r.categoryId,
      name: r.name,
      available,
      availableLabel: r.availableLabel,
      status: r.status,
      payoutCents,
      payoutLabel: r.payoutLabel,
    };
  });

  const { newlyUnlocked } = upsertGrowthRows(inventory);
  if (newlyUnlocked.length) {
    console.log(
      `[growth] ${newlyUnlocked.length} category unlock signal(s): ${newlyUnlocked
        .map((c) => `#${c.categoryId} ${c.name}`)
        .join(", ")}`,
    );
  }

  return inventory;
}

/**
 * Growth-aware pick: live stock required, then highest payout ¢.
 * @deprecated name kept — delegates to pickGrowthCategory
 */
export function pickBestWithInventory(
  inventory: CategoryInventory[],
  excludeIds: number[] = [],
): CategoryInventory | null {
  const picked = pickGrowthCategory(inventory as InventoryForGrowth[], { excludeIds });
  return picked as CategoryInventory | null;
}

export function pickBestGrowthWithInventory(
  inventory: CategoryInventory[],
  opts: {
    excludeIds?: number[];
    preferId?: number | null;
    accuracyByName?: Map<string, number>;
    accuracyFirst?: boolean;
  } = {},
): CategoryInventory | null {
  return pickGrowthCategory(inventory as InventoryForGrowth[], opts) as CategoryInventory | null;
}
