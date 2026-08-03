import fs from "fs";
import path from "path";
import { Page } from "playwright";
import { DiscoveredSelectors } from "./types";
import { DEFAULT_SELECTORS } from "./humanatic";
import { loadDiscoveredSelectors, saveDiscoveredSelectors } from "./storage";

const analysisDir = path.resolve(process.cwd(), "analysis-output");

const ensureAnalysisDir = (): void => {
  if (!fs.existsSync(analysisDir)) {
    fs.mkdirSync(analysisDir, { recursive: true });
  }
};

export const savePageSnapshot = async (page: Page, label: string): Promise<string> => {
  ensureAnalysisDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(analysisDir, `${stamp}-${label}`);
  const htmlPath = `${base}.html`;
  const pngPath = `${base}.png`;

  try {
    const html = await page.content();
    fs.writeFileSync(htmlPath, html, "utf-8");
  } catch (err) {
    console.warn(`[dom] Failed to save HTML snapshot: ${err}`);
  }

  try {
    await page.screenshot({ path: pngPath, fullPage: true });
  } catch (err) {
    console.warn(`[dom] Failed to save screenshot: ${err}`);
  }

  console.log(`[dom] Snapshot saved under ${base}.*`);
  return base;
};

type DiscoveryResult = {
  selectors: DiscoveredSelectors;
  reviewUiFound: boolean;
  notes: string[];
};

/**
 * Probe the live page for review UI and build selector overrides.
 */
export const discoverReviewSelectors = async (page: Page): Promise<DiscoveryResult> => {
  const notes: string[] = [];

  const probe = await page.evaluate(() => {
    const cssPath = (el: Element | null): string | null => {
      if (!el) return null;
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur.nodeType === 1 && parts.length < 5) {
        let part = cur.tagName.toLowerCase();
        if (cur.classList.length) {
          const cls = Array.from(cur.classList)
            .filter((c) => c.length < 40 && !/^[a-f0-9]{8,}$/i.test(c))
            .slice(0, 2);
          if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
        }
        const parent: Element | null = cur.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
          if (siblings.length > 1) {
            const idx = siblings.indexOf(cur) + 1;
            part += `:nth-of-type(${idx})`;
          }
        }
        parts.unshift(part);
        cur = parent;
        if (cur?.tagName === "BODY" || cur?.tagName === "HTML") break;
      }
      return parts.join(" > ");
    };

    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    const checkboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).filter((el) => {
      const name = (el.name || "").toLowerCase();
      const id = (el.id || "").toLowerCase();
      return !name.includes("remember") && !id.includes("remember");
    });
    const options = radios.length ? radios : checkboxes;

    let optionRoot: Element | null = null;
    if (options.length) {
      optionRoot = options[0].closest("form, fieldset, table, .panel, .card, [class*='review'], [class*='category'], main, #content") ||
        options[0].parentElement;
    }

    const transcriptCandidates = Array.from(
      document.querySelectorAll(
        "[class*='transcript'], [id*='transcript'], [class*='conversation'], [class*='dialog'], pre, textarea",
      ),
    );
    let transcriptEl: Element | null = null;
    let bestLen = 0;
    for (const el of transcriptCandidates) {
      const text = (el.textContent || "").trim();
      if (text.length > bestLen && text.length > 40) {
        bestLen = text.length;
        transcriptEl = el;
      }
    }
    if (!transcriptEl) {
      // Fallback: largest text block that isn't nav
      const blocks = Array.from(document.querySelectorAll("div, section, article, td"));
      for (const el of blocks) {
        const text = (el.textContent || "").trim();
        if (text.length > bestLen && text.length > 120 && text.length < 50000) {
          const childCount = el.querySelectorAll("div").length;
          if (childCount < 40) {
            bestLen = text.length;
            transcriptEl = el;
          }
        }
      }
    }

    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      "button, input[type='submit'], a.btn, [role='button']",
    ));
    const submitEl =
      buttons.find((b) => /submit|next|save|continue|done|score|rate/i.test(`${b.textContent || ""} ${b.value || ""}`)) ||
      document.querySelector("button[type='submit'], input[type='submit']");

    const infoIcon =
      document.querySelector(
        "[class*='info'], [title*='info' i], [aria-label*='info' i], .fa-info, .fa-info-circle, [data-tooltip], a[href*='help']",
      ) || null;

    const titleEl =
      document.querySelector("h1, h2, h3, .category-title, .category-name, [class*='category']") || null;

    const queueEmpty =
      Array.from(document.querySelectorAll("body *")).find((el) =>
        /no (more )?calls|queue (is )?empty|nothing to review|no reviews available/i.test(
          (el.textContent || "").trim(),
        ),
      ) || null;

    return {
      radioCount: radios.length,
      checkboxCount: checkboxes.length,
      optionCount: options.length,
      callContainer: cssPath(optionRoot),
      optionSample: options.slice(0, 8).map((o) => ({
        id: o.id,
        name: o.name,
        value: o.value,
        label:
          (o.id && document.querySelector(`label[for='${o.id}']`)?.textContent?.trim()) ||
          o.getAttribute("aria-label") ||
          o.value ||
          "",
      })),
      transcript: cssPath(transcriptEl),
      transcriptLen: bestLen,
      submit: cssPath(submitEl),
      infoIcon: cssPath(infoIcon),
      categoryTitle: cssPath(titleEl),
      queueEmptyText: queueEmpty ? (queueEmpty.textContent || "").trim().slice(0, 120) : null,
      bodySnippet: (document.body?.innerText || "").slice(0, 500),
      url: location.href,
      title: document.title,
    };
  });

  notes.push(`URL: ${probe.url}`);
  notes.push(`Title: ${probe.title}`);
  notes.push(`Options found: ${probe.optionCount} (radios=${probe.radioCount})`);
  notes.push(`Transcript length guess: ${probe.transcriptLen}`);

  const titleLower = (probe.title || "").toLowerCase();
  const isChallengePage =
    titleLower.includes("just a moment") ||
    titleLower.includes("please wait") ||
    /login\.cfm|\/login/i.test(probe.url || "") && probe.optionCount === 0;

  // Require real review controls — never treat Cloudflare / login interstitial as review UI
  const reviewUiFound = !isChallengePage && probe.optionCount > 0;

  const selectors: DiscoveredSelectors = {
    ...DEFAULT_SELECTORS,
    callContainer: probe.callContainer || DEFAULT_SELECTORS.callContainer,
    categoryInfoIcon: probe.infoIcon || DEFAULT_SELECTORS.categoryInfoIcon,
    categoryTitle: probe.categoryTitle || DEFAULT_SELECTORS.categoryTitle,
    optionInputs: probe.radioCount > 0 ? 'input[type="radio"]' : DEFAULT_SELECTORS.optionInputs,
    transcriptElement: probe.transcript || DEFAULT_SELECTORS.transcriptElement,
    submitButton: probe.submit || DEFAULT_SELECTORS.submitButton,
    queueEmpty: probe.queueEmptyText
      ? "body"
      : undefined,
  };

  if (reviewUiFound) {
    saveDiscoveredSelectors(selectors);
    notes.push("Saved discovered selectors to data/selectors.json");
  } else {
    notes.push("Review UI not clearly found — snapshot will be saved for manual fix");
  }

  // Persist probe details for debugging
  ensureAnalysisDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(analysisDir, `${stamp}-discovery.json`),
    JSON.stringify({ probe, notes }, null, 2),
    "utf-8",
  );

  return { selectors, reviewUiFound, notes };
};

/**
 * Merge defaults + saved discoveries into the active selector set.
 */
export const getActiveSelectors = (): DiscoveredSelectors => {
  const saved = loadDiscoveredSelectors();
  return { ...DEFAULT_SELECTORS, ...(saved || {}) };
};
