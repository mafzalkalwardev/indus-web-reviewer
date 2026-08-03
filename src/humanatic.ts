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
  loginButton: "button[type='submit'], .btn-login, #loginBtn, input[type='submit']",
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
  await page.waitForSelector(sel.optionInputs, { timeout: 30000 }).catch(async () => {
    await page.waitForSelector(sel.callContainer, { timeout: 15000 });
  });

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
    const categoryId =
      hcat ||
      container.getAttribute("data-category-id") ||
      document.querySelector("[data-category-id]")?.getAttribute("data-category-id") ||
      firstOption?.getAttribute("name") ||
      "unknown-category";

    const callId =
      container.getAttribute("data-call-id") ||
      document.querySelector("[data-call-id]")?.getAttribute("data-call-id") ||
      undefined;

    const categoryName =
      container.querySelector(s.categoryTitle)?.textContent?.trim() ||
      document.querySelector(s.categoryTitle)?.textContent?.trim() ||
      document.body?.innerText?.match(/Category Instructions:\s*([^\n]+)/i)?.[1]?.trim() ||
      undefined;

    return { categoryId, callId: callId || undefined, categoryName };
  }, sel);

  if (!metadata) {
    throw new Error("Unable to inspect active Humanatic portal session.");
  }

  return metadata;
};

/**
 * Read review options from the live DOM with stable ids (id || name:value || value).
 */
export const readLiveOptions = async (page: Page): Promise<ReviewOption[]> => {
  const sel = selectors();
  const options = await page.evaluate((s) => {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(s.optionInputs)).filter(
      (input) => {
        const name = (input.name || "").toLowerCase();
        const id = (input.id || "").toLowerCase();
        if (input.type === "checkbox" && (name.includes("remember") || id.includes("remember"))) {
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
 * Capture the call transcript from the review page.
 * Falls back to Whisper transcription of <audio> when no text transcript exists.
 */
export const captureTranscript = async (page: Page): Promise<string> => {
  const sel = selectors();
  const transcriptHandle = await page.$(sel.transcriptElement);
  if (transcriptHandle) {
    const transcript = await transcriptHandle.textContent();
    const trimmed = transcript?.trim() || "";
    if (trimmed.length > 20) return trimmed;
  }

  const textContent = await page.evaluate(() => {
    const elements = document.querySelectorAll(
      "[class*='transcript'], [id*='transcript'], [class*='call-'], .conversation, [class*='dialog'], pre, textarea",
    );
    for (let i = 0; i < elements.length; i++) {
      const text = elements[i].textContent?.trim() || (elements[i] as HTMLTextAreaElement).value;
      if (text && text.length > 50) return text;
    }
    return null;
  });

  if (textContent) return textContent;

  const audioUrl = await page.evaluate((audioSel) => {
    const audio = document.querySelector(audioSel) as HTMLAudioElement | null;
    if (audio?.currentSrc || audio?.src) return audio.currentSrc || audio.src;
    const source = document.querySelector("audio source") as HTMLSourceElement | null;
    return source?.src || "";
  }, sel.audioSource);

  if (audioUrl) {
    const { transcribeAudioUrl } = await import("./whisper");
    return transcribeAudioUrl(audioUrl);
  }

  throw new Error("Transcript element not found and no audio source available.");
};

/**
 * Select a review radio/checkbox by stable id / value / label binding (no submit).
 */
export const selectReviewChoice = async (page: Page, selectedOptionId: string): Promise<void> => {
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
