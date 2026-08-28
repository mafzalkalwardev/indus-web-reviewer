import { Page } from "playwright";
import { CategoryRule, DiscoveredSelectors, ReviewOption } from "./types";
import { getActiveSelectors } from "./domDiscovery";

/**
 * Humanatic Portal Selectors — defaults used until live discovery overrides them.
 */
export const DEFAULT_SELECTORS: DiscoveredSelectors = {
  callContainer: ".review-session, [data-category-id], .call-review-container, form, main, #content, body",
  categoryInfoIcon:
    ".category-info-icon, [data-tooltip], .info-icon, .category-info, .fa-info-circle, [aria-label*='info' i]",
  categoryTitle: ".category-title, .category-name, h2.category-header, h1, h2, h3",
  optionInputs: 'input[type="radio"], input[type="checkbox"]',
  transcriptElement:
    ".transcript-text, .call-transcript, .transcript-container, [class*='transcript'], [id*='transcript']",
  audioSource: "audio, [data-audio-source], .audio-player",
  submitButton:
    "button[type=submit], input[type=submit], .submit-review, .next-review, [data-action='submit']",
  loginForm: "#login-form, form[action*='login'], .login-form",
  emailInput: "input[name='email'], input[name='username'], input[type='email'], input[name='login']",
  passwordInput: "input[name='password'], input[type='password']",
  loginButton: "button[type='submit'], input[type='submit'], .btn-login, #loginBtn",
};

export type HumanaticSelectors = DiscoveredSelectors;

const selectors = (): DiscoveredSelectors => getActiveSelectors();

/**
 * Inspect the active Humanatic review portal page to extract metadata.
 */
export const inspectPortal = async (
  page: Page,
): Promise<{ categoryId: string; callId?: string; categoryName?: string }> => {
  const sel = selectors();
  const hasHumfun = (await page.locator(".humfun-options-list-item").count().catch(() => 0)) >= 2;
  if (!hasHumfun) {
    await page.waitForSelector(sel.optionInputs, { timeout: 30000 }).catch(async () => {
      await page.waitForSelector(sel.callContainer, { timeout: 15000 });
    });
  }

  const metadata = await page.evaluate((s) => {
    const container =
      document.querySelector(s.callContainer) ||
      document.querySelector("form") ||
      document.body;

    if (!container) return null;

    const url = location.href;
    const hcat =
      url.match(/[?&]hcat=(\d+)/i)?.[1] ||
      url.match(/[?&]category=(\d+)/i)?.[1] ||
      null;

    const firstOption = container.querySelector<HTMLInputElement>(s.optionInputs);
    const humfunHco = (
      document.querySelector(".humfun-options-list-item-hco")?.textContent || ""
    ).trim();
    // Never use radio/input name like takeABreak as category id
    const optName = (firstOption?.getAttribute("name") || "").trim();
    const safeOptName =
      optName && !/break|take\s*a\s*break|remember|csrf/i.test(optName) ? optName : null;

    const categoryId =
      hcat ||
      container.getAttribute("data-category-id") ||
      document.querySelector("[data-category-id]")?.getAttribute("data-category-id") ||
      safeOptName ||
      (humfunHco ? "humfun-live" : null) ||
      "unknown-category";

    const callId =
      container.getAttribute("data-call-id") ||
      document.querySelector("[data-call-id]")?.getAttribute("data-call-id") ||
      (document.querySelector('input[name="cid"]') as HTMLInputElement | null)?.value ||
      undefined;

    const rawName =
      container.querySelector(s.categoryTitle)?.textContent?.trim() ||
      document.querySelector(s.categoryTitle)?.textContent?.trim() ||
      document.querySelector(".humfun-options-header-title")?.textContent?.trim() ||
      document.body?.innerText?.match(/Category Instructions:\s*([^\n]+)/i)?.[1]?.trim() ||
      undefined;
    // Ignore UI chrome mistaken as category title (Take a Break button, etc.)
    const categoryName =
      rawName && !/take\s*a\s*break|break\s*room|continue\s*reviewing/i.test(rawName)
        ? rawName
        : undefined;

    return { categoryId, callId: callId || undefined, categoryName };
  }, sel);

  if (!metadata) {
    throw new Error("Unable to inspect active Humanatic portal session.");
  }

  return metadata;
};

/**
 * Read review options from the live DOM with stable ids (id || name:value || value).
 * Supports classic radios and Humfun /x19/review.cfm card options.
 */
export const readLiveOptions = async (page: Page): Promise<ReviewOption[]> => {
  const humfunCount = await page.locator(".humfun-options-list-item").count().catch(() => 0);
  if (humfunCount >= 2) {
    const { readHumfunOptions } = await import("./humfunReview");
    return readHumfunOptions(page);
  }

  const sel = selectors();
  const options = await page.evaluate((s) => {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(s.optionInputs)).filter(
      (input) => {
        const name = (input.name || "").toLowerCase();
        const id = (input.id || "").toLowerCase();
        if (input.type === "checkbox" && (name.includes("remember") || id.includes("remember"))) {
          return false;
        }
        if (input.type === "checkbox" && (name.includes("break") || id.includes("break"))) {
          return false;
        }
        return input.type === "radio" || input.type === "checkbox";
      },
    );

    return inputs.map((input, index) => {
      const label =
        (input.id && document.querySelector(`label[for='${CSS.escape(input.id)}']`)?.textContent?.trim()) ||
        input.closest("label")?.textContent?.trim() ||
        input.getAttribute("aria-label") ||
        input.value ||
        `Option ${index + 1}`;

      const id =
        input.id ||
        (input.name && input.value ? `${input.name}:${input.value}` : "") ||
        input.value ||
        `option-${index}`;

      return {
        id,
        name: input.name || "",
        label: label.replace(/\s+/g, " ").trim(),
        criteria: label.replace(/\s+/g, " ").trim(),
        value: input.value || undefined,
      };
    });
  }, sel);

  // Humanatic often duplicates the same option set across radio1/radio2/radio3 groups.
  // Prefer the first radio group so Grok sees one clean choice set.
  const groups = new Map<string, typeof options>();
  for (const opt of options) {
    const g = opt.name || "default";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(opt);
  }
  const firstGroup = groups.values().next().value || options;
  const seen = new Set<string>();
  const deduped: ReviewOption[] = [];
  for (const opt of firstGroup) {
    const key = opt.label.replace(/^\d+/, "").trim().toLowerCase() || opt.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      id: opt.id,
      label: opt.label.replace(/^\d+/, "").trim() || opt.label,
      criteria: opt.criteria.replace(/^\d+/, "").trim() || opt.criteria,
      value: opt.value,
    });
  }
  return deduped.length ? deduped : options.map(({ id, label, criteria, value }) => ({ id, label, criteria, value }));
};

/**
 * Extract review rules by clicking the category info icon (when present) and reading options.
 */
export const extractRulesFromInfoIcon = async (page: Page): Promise<CategoryRule> => {
  const sel = selectors();
  const icon = await page.$(sel.categoryInfoIcon);
  let rulesText = "";
  let categoryName: string | undefined;

  if (icon) {
    try {
      await icon.click({ timeout: 3000 });
      await page.waitForTimeout(500);
      const popupData = await page.evaluate(() => {
        const popup = document.querySelector(
          ".tooltip-content, .popover, .category-info-popup, [class*='tooltip'], [class*='popup'], [role='tooltip'], [role='dialog']",
        );
        if (!popup) return null;
        const name =
          popup.querySelector("h1, h2, .title, .category-name")?.textContent?.trim() || undefined;
        const rules = Array.from(popup.querySelectorAll("p, li, .rule-text, .criteria, td, div"))
          .map((node) => node.textContent?.trim())
          .filter((t) => t && t.length > 5)
          .slice(0, 40)
          .join("\n");
        return { name, rules };
      });
      if (popupData) {
        categoryName = popupData.name;
        rulesText = popupData.rules || "";
      }
    } catch {
      console.warn("[humanatic] Info icon click failed — continuing with option labels as rules");
    }
  } else {
    console.warn("[humanatic] Category info icon not found — using option labels as rules");
  }

  const options = await readLiveOptions(page);
  if (!options.length) {
    throw new Error("No review options found on the page.");
  }

  if (!rulesText) {
    rulesText = options.map((o) => `- ${o.label}`).join("\n");
  }

  if (!categoryName) {
    const meta = await inspectPortal(page).catch(() => null);
    categoryName = meta?.categoryName || meta?.categoryId || "Unknown Category";
  }

  return {
    category_id: `category-${Date.now()}`,
    category_name: categoryName,
    rules: rulesText,
    options,
  };
};

/**
 * Phrases that only ever appear in Humanatic's category instructions / practice
 * scaffolding — never inside a real caller conversation. If scraped page text
 * contains any of these we are looking at the instructions page, not a call.
 */
const INSTRUCTION_MARKERS: RegExp[] = [
  /category\s+instructions/i,
  /practice\s+questions/i,
  /here\s+are\s+the\s+options/i,
  /submit\s+review/i,
  /selections?\s+will\s+be\s+available/i,
  /please\s+complete\s+all\s+practice/i,
  /was\s+the\s+call\s+handled\s+by\s+a\s+qualified\s+employee/i,
  /^\s*handled\s+by\s+a\s+qualified\s+employee/i,
  /not\s+handled:\s*(other|voicemail|nobody)/i,
];

/**
 * True when scraped text is Humanatic chrome (instructions, option labels,
 * practice blocks) rather than an actual call transcript.
 *
 * This guard exists because the old loose DOM scrape happily returned the
 * instructions wall as a "transcript", which the LLM then agreed with at
 * confidence 1.0. See data/reviews.json for the historical damage.
 */
export const looksLikeInstructions = (text: string, optionLabels: string[] = []): boolean => {
  const t = (text || "").trim();
  if (!t) return true;

  if (INSTRUCTION_MARKERS.some((re) => re.test(t))) return true;

  // If most of the option labels appear verbatim, this is the options list.
  const labels = optionLabels.map((l) => l.trim().toLowerCase()).filter((l) => l.length > 12);
  if (labels.length >= 2) {
    const lower = t.toLowerCase();
    const hits = labels.filter((l) => lower.includes(l)).length;
    if (hits >= Math.min(2, labels.length)) return true;
  }

  return false;
};

/** Resolve the call audio URL from <audio>, <source>, or a data attribute. */
const findAudioUrl = async (page: Page): Promise<string> => {
  const sel = selectors();
  return page
    .evaluate((audioSel) => {
      const audio = document.querySelector(audioSel) as HTMLAudioElement | null;
      if (audio?.currentSrc || audio?.src) return audio.currentSrc || audio.src;
      const source = document.querySelector("audio source") as HTMLSourceElement | null;
      if (source?.src) return source.src;
      const anyAudio = document.querySelector("audio") as HTMLAudioElement | null;
      if (anyAudio?.currentSrc || anyAudio?.src) return anyAudio.currentSrc || anyAudio.src;
      const dataAttr = document.querySelector("[data-audio-source]") as HTMLElement | null;
      return dataAttr?.getAttribute("data-audio-source") || "";
    }, sel.audioSource)
    .catch(() => "");
};

/**
 * Capture the call transcript from the review page.
 *
 * Order matters: audio → Whisper is the ONLY reliable source of the actual
 * conversation. DOM text is used solely when a dedicated transcript container
 * exists AND it survives the instructions guard.
 */
export const captureTranscript = async (
  page: Page,
  optionLabels: string[] = [],
): Promise<string> => {
  const sel = selectors();

  // 1) Real audio → Whisper. This is the source of truth.
  const audioUrl = await findAudioUrl(page);
  if (audioUrl) {
    const { transcribeAudioUrl } = await import("./whisper");
    const cookieHeader = await page
      .context()
      .cookies(audioUrl)
      .then((cookies) => cookies.map((c) => `${c.name}=${c.value}`).join("; "))
      .catch(() => "");
    const spoken = (await transcribeAudioUrl(audioUrl, cookieHeader)).trim();
    if (spoken && spoken !== "(no speech detected)") {
      if (looksLikeInstructions(spoken, optionLabels)) {
        throw new Error("Whisper output matched instructions text — refusing to use as transcript.");
      }
      return spoken;
    }
    // Genuinely silent call — that IS the signal (dead air / no answer).
    console.warn("[transcript] Whisper returned no speech — treating as silent call");
    return "(no speech detected)";
  }

  // 2) Dedicated transcript container only — never a broad wildcard class sweep.
  const domText = await page
    .evaluate((transcriptSel) => {
      const nodes = Array.from(document.querySelectorAll(transcriptSel));
      for (const node of nodes) {
        const text =
          (node as HTMLTextAreaElement).value?.trim() || node.textContent?.trim() || "";
        if (text.length > 40) return text;
      }
      return "";
    }, sel.transcriptElement)
    .catch(() => "");

  if (domText && !looksLikeInstructions(domText, optionLabels)) {
    return domText;
  }

  if (domText) {
    console.warn(
      `[transcript] Rejected ${domText.length} chars of instructions-like text (no audio present)`,
    );
  }

  throw new Error(
    "No call audio and no valid transcript on page — refusing to decide on instructions text.",
  );
};

/**
 * Select a review radio/checkbox by stable id / value / label binding (no submit).
 */
export const selectReviewChoice = async (page: Page, selectedOptionId: string): Promise<void> => {
  const humfunCount = await page.locator(".humfun-options-list-item").count().catch(() => 0);
  if (humfunCount >= 2) {
    // Selection without submit — click the card only
    const ok = await page.evaluate((id) => {
      const items = Array.from(document.querySelectorAll(".humfun-options-list-item"));
      const item = items.find((el) => {
        const hco = (el.querySelector(".humfun-options-list-item-hco")?.textContent || "").trim();
        return hco === id;
      }) as HTMLElement | undefined;
      if (!item) return false;
      item.scrollIntoView({ block: "center" });
      item.click();
      const send = document.querySelector("#sendThis") as HTMLInputElement | null;
      if (send) send.value = id;
      return true;
    }, selectedOptionId);
    if (!ok) throw new Error(`Unable to find Humfun option ${selectedOptionId}`);
    await page.waitForTimeout(200);
    return;
  }

  const sel = selectors();

  const clicked = await page.evaluate(
    ({ optionId, optionSelector }) => {
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(optionSelector));
      const match = inputs.find((input, index) => {
        const composed =
          input.id ||
          (input.name && input.value ? `${input.name}:${input.value}` : "") ||
          input.value ||
          `option-${index}`;
        return (
          composed === optionId ||
          input.id === optionId ||
          input.value === optionId ||
          `${input.name}:${input.value}` === optionId
        );
      });
      if (!match) return false;
      match.scrollIntoView({ block: "center" });
      match.checked = true;
      match.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      match.click();
      match.dispatchEvent(new Event("change", { bubbles: true }));
      match.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    { optionId: selectedOptionId, optionSelector: sel.optionInputs },
  );

  if (!clicked) {
    throw new Error(`Unable to find review input for option id ${selectedOptionId}`);
  }

  await page.waitForTimeout(200);
};

/**
 * Select then submit the review choice (live audits only).
 */
export const submitReviewChoice = async (page: Page, selectedOptionId: string): Promise<void> => {
  const humfunCount = await page.locator(".humfun-options-list-item").count().catch(() => 0);
  if (humfunCount >= 2) {
    const { selectAndSubmitHumfun, optionsStillLocked } = await import("./humfunReview");
    // Only block when lock overlay is truly visible (tip text can linger after unlock)
    if (await optionsStillLocked(page)) {
      throw new Error("Options still locked — finish listening before submit");
    }
    const delayMs = 800 + Math.floor(Math.random() * 1200);
    await page.waitForTimeout(delayMs);
    await selectAndSubmitHumfun(page, selectedOptionId);
    return;
  }

  const sel = selectors();
  await selectReviewChoice(page, selectedOptionId);

  const submitButton = await page.$(sel.submitButton);
  if (!submitButton) {
    // Fallback: click any button that looks like submit/next
    const fallback = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
          "button, input[type='submit'], a.btn, [role='button']",
        ),
      );
      const btn = buttons.find((b) =>
        /submit|next|save|continue|done|score|rate/i.test(`${b.textContent || ""} ${b.value || ""}`),
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!fallback) throw new Error("Submit button not found.");
  } else {
    const delayMs = 1500 + Math.floor(Math.random() * 2000);
    await page.waitForTimeout(delayMs);
    await submitButton.click();
  }
};

/**
 * Detect queue-empty messaging on the page.
 */
export const isQueueEmpty = async (page: Page): Promise<boolean> => {
  const url = page.url().toLowerCase();
  // Category list always contains "no calls" text for empty rows — never treat it as queue-empty.
  if (url.includes("category.cfm") && !url.includes("category_selector")) {
    return false;
  }
  if (/nocalls\.cfm/i.test(url)) return true;

  return page.evaluate(() => {
    const text = (document.body?.innerText || "").toLowerCase();
    // Prefer explicit empty-queue pages / banners
    if (document.querySelector(".no-calls, #noCalls, .nocalls")) return true;
    return (
      /no calls here/.test(text) ||
      /no (more )?calls (available|to review)/.test(text) ||
      /queue (is )?empty/.test(text) ||
      /nothing to review/.test(text) ||
      /no reviews available/.test(text) ||
      /all caught up/.test(text) ||
      /more reviewers than there are pending calls/.test(text)
    );
  });
};

/**
 * Wait until a new call appears (options/transcript change) or timeout.
 */
export const waitForNextCall = async (
  page: Page,
  previousCallFingerprint: string,
  timeoutMs: number,
): Promise<"ready" | "idle" | "empty"> => {
  const { ensureClearOfBreakRoom, looksLikeBreakRoom } = await import("./breakRoom");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await looksLikeBreakRoom(page)) {
      await ensureClearOfBreakRoom(page);
      await page.waitForTimeout(1000);
      continue;
    }

    if (await isQueueEmpty(page)) return "empty";

    const fingerprint = await page.evaluate(() => {
      const options = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
        .map((i) => i.value || i.id)
        .join("|");
      const transcript = (
        document.querySelector("[class*='transcript'], [id*='transcript']")?.textContent || ""
      )
        .trim()
        .slice(0, 200);
      return `${location.href}::${options}::${transcript}`;
    });

    if (fingerprint && fingerprint !== previousCallFingerprint) {
      // Debounce DOM settle
      await page.waitForTimeout(1000);
      return "ready";
    }

    await page.waitForTimeout(1500);
  }
  return "idle";
};

export const getCallFingerprint = async (page: Page): Promise<string> => {
  return page.evaluate(() => {
    const options = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
      .map((i) => i.value || i.id)
      .join("|");
    const transcript = (
      document.querySelector("[class*='transcript'], [id*='transcript']")?.textContent || ""
    )
      .trim()
      .slice(0, 200);
    return `${location.href}::${options}::${transcript}`;
  });
};
