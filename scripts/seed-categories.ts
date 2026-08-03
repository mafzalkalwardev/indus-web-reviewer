/**
 * Seed data/categories.json from scraped analysis-output/categories/ALL_CATEGORIES.json
 * so Grok has real instruction text before live/practice audits.
 */
import fs from "fs";
import path from "path";
import { CategoryRule, ReviewOption } from "../src/types";
import { loadCategoryCache, saveCategoryCache } from "../src/storage";

const scrapedPath = path.resolve(process.cwd(), "analysis-output", "categories", "ALL_CATEGORIES.json");
const queueDir = path.resolve(process.cwd(), "analysis-output", "categories");

type Scraped = {
  categoryId: number | null;
  name: string;
  instructions?: string;
  status?: string;
};

const loadQueueOptions = (id: number): ReviewOption[] => {
  const files = fs.readdirSync(queueDir).filter((f) => f.startsWith(`${id}-`) && f.endsWith("-queue.json"));
  if (!files.length) return [];
  const raw = JSON.parse(fs.readFileSync(path.join(queueDir, files[0]), "utf8")) as {
    radios?: Array<{ id: string; label: string; value?: string }>;
  };
  // Prefer first radio group only (radio1_*) — duplicate groups are usually UI clones
  const radios = (raw.radios || []).filter((r) => /_1$/.test(r.id) || r.id.startsWith("radio"));
  const seen = new Set<string>();
  const options: ReviewOption[] = [];
  for (const r of radios) {
    const label = (r.label || "").replace(/^\d+/, "").trim() || r.label;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({
      id: r.id,
      label,
      criteria: label,
      value: r.value,
    });
  }
  return options;
};

function main() {
  if (!fs.existsSync(scrapedPath)) {
    throw new Error(`Missing ${scrapedPath} — run scrape-category-info first`);
  }
  const scraped = JSON.parse(fs.readFileSync(scrapedPath, "utf8")) as Scraped[];
  const existing = loadCategoryCache();
  const byId = new Map(existing.map((c) => [c.category_id, c]));

  for (const row of scraped) {
    if (row.categoryId == null) continue;
    const id = String(row.categoryId);
    const instructions = (row.instructions || "").trim();
    if (!instructions || /^Welcome to Humanatic/i.test(instructions)) {
      console.warn(`[seed] Skipping ${id} ${row.name} — no usable instructions`);
      continue;
    }
    const options = loadQueueOptions(row.categoryId);
    const prev = byId.get(id);
    const next: CategoryRule = {
      category_id: id,
      category_name: row.name,
      rules: instructions,
      options: options.length ? options : prev?.options || [],
    };
    byId.set(id, next);
    console.log(
      `[seed] ${id} ${row.name} | rules=${instructions.length} chars | options=${next.options.length}`,
    );
  }

  const merged = Array.from(byId.values());
  saveCategoryCache(merged);
  console.log(`[seed] Wrote ${merged.length} categories → data/categories.json`);
}

main();
