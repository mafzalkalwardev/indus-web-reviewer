/**
 * Scene intelligence: classify what Humanatic is showing right now
 * (URL + DOM), and recommend the next worker action.
 */
import { Page } from "playwright";

export type PageKind =
  | "login"
  | "logout"
  | "face_verify"
  | "break_room"
  | "cloudflare"
  | "category_list"
  | "profile"
  | "no_calls"
  | "practice_intro"
  | "call_intro"
  | "live_review"
  | "unknown";

export type RecommendedAction =
  | "login"
  | "wait_face"
  | "clear_break_room"
  | "wait_challenge"
  | "open_category"
  | "complete_practice"
  | "click_review_calls"
  | "review_call"
  | "hold_call"
  | "wait_empty"
  | "wait"
  | "idle";

export type PageScene = {
  kind: PageKind;
  action: RecommendedAction;
  url: string;
  title: string;
  categoryId: string | null;
  summary: string;
  details: {
    heading: string | null;
    practiceBlocks: number;
    practiceDone: number;
    radios: number;
    radiosChecked: number;
    audios: number;
    submitEnabled: boolean;
    hasInitialsForm: boolean;
    hasReviewCalls: boolean;
    hasContinueReviewing: boolean;
    optionLabels: string[];
    bodySnippet: string;
  };
  confidence: number;
};

type DomSnapshot = {
  title: string;
  text: string;
  heading: string | null;
  practiceBlocks: number;
  practiceDone: number;
  radios: number;
  radiosChecked: number;
  audios: number;
  submitEnabled: boolean;
  hasInitialsForm: boolean;
  hasReviewCalls: boolean;
  hasContinueReviewing: boolean;
  hasLoginForm: boolean;
  hasTurnstile: boolean;
  optionLabels: string[];
  looksBreakRoom: boolean;
};

async function readDom(page: Page): Promise<DomSnapshot> {
  return page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const lower = text.toLowerCase();

    const practiceBlocks = document.querySelectorAll(".practice-review").length;
    const practiceDone = Array.from(document.querySelectorAll(".practice-review")).filter((b) => {
      const nice = b.querySelector(".hum-101-review-buttons") as HTMLElement | null;
      return !!(nice && getComputedStyle(nice).display !== "none");
    }).length;

    const radioEls = Array.from(document.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    const radios = radioEls.length;
    const radiosChecked = radioEls.filter((r) => r.checked).length;

    const humfunOptions = document.querySelectorAll(".humfun-options-list-item").length;
    const effectiveChoices = Math.max(radios, humfunOptions);

    const audios = document.querySelectorAll("audio").length;

    const submitEnabled = Array.from(
      document.querySelectorAll(".submit-button, .submit-review, input.subbutton"),
    ).some((el) => {
      const input = el as HTMLInputElement;
      if (input.disabled) return false;
      if (el.classList.contains("not-active")) return false;
      return true;
    });

    const optionLabels = Array.from(
      document.querySelectorAll(
        ".option .the-label, .option label, .humfun-options-list-item-text",
      ),
    )
      .map((n) => (n.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 12);

    const heading =
      Array.from(document.querySelectorAll("h1,h2,h3,.page-title,.humfun-options-header-title"))
        .map((h) => (h.textContent || "").replace(/\s+/g, " ").trim())
        .find((t) => t.length > 3) ||
      (lower.includes("practice questions") ? "Practice Questions" : null);

    return {
      title: document.title || "",
      text: text.slice(0, 500),
      heading,
      practiceBlocks,
      practiceDone,
      radios: effectiveChoices,
      radiosChecked,
      audios,
      submitEnabled,
      hasInitialsForm: !!document.querySelector('input[name="initials"]'),
      hasReviewCalls: !!(
        document.querySelector('a[href*="category_selector.cfm"]') ||
        document.querySelector(".category-review-btn, .category-review-btn-text") ||
        Array.from(
          document.querySelectorAll("a, button, input[type='button'], input[type='submit'], [role='button'], span"),
        ).some((el) =>
          /review\s+calls/i.test(
            (el as HTMLElement).innerText || (el as HTMLInputElement).value || "",
          ),
        )
      ),
      hasContinueReviewing: Array.from(
        document.querySelectorAll("a, button, input[type='button'], input[type='submit'], [role='button']"),
      ).some((el) =>
        /continue\s+reviewing\s+calls/i.test(
          (el as HTMLElement).innerText || (el as HTMLInputElement).value || "",
        ),
      ),
      hasLoginForm: !!(
        document.querySelector('input[type="password"]') &&
        document.querySelector('input[name="username"], input[name="email"], input[type="email"], input[name="login"]')
      ),
      hasTurnstile: !!(
        document.querySelector("#challenge-form, .cf-turnstile, iframe[src*='challenges.cloudflare']") ||
        /verify you are human|just a moment/i.test(text)
      ),
      optionLabels,
      looksBreakRoom:
        lower.includes("welcome to the break room") ||
        (lower.includes("break room") && lower.includes("please wait")),
    };
  });
}

function categoryFromUrl(url: string): string | null {
  return url.match(/[?&]hcat=(\d+)/i)?.[1] || url.match(/[?&]category=(\d+)/i)?.[1] || null;
}

function classify(url: string, dom: DomSnapshot): Omit<PageScene, "url" | "title" | "details"> & {
  summary: string;
} {
  const u = url.toLowerCase();
  const cat = categoryFromUrl(url);

  if (dom.hasTurnstile || /cdn-cgi\/challenge/i.test(u)) {
    return {
      kind: "cloudflare",
      action: "wait_challenge",
      categoryId: cat,
      summary: "Cloudflare challenge — waiting for pass",
      confidence: 0.95,
    };
  }

  if (u.includes("logout.cfm")) {
    return {
      kind: "logout",
      action: "login",
      categoryId: cat,
      summary: "Logged out",
      confidence: 0.99,
    };
  }

  if (u.includes("login.cfm") || dom.hasLoginForm) {
    return {
      kind: "login",
      action: "login",
      categoryId: cat,
      summary: "Login page",
      confidence: 0.98,
    };
  }

  if (u.includes("face_verify") || /face\s*verif/i.test(dom.text)) {
    return {
      kind: "face_verify",
      action: "wait_face",
      categoryId: cat,
      summary: "Face verification — waiting for Tampermonkey / webcam clear",
      confidence: 0.95,
    };
  }

  if (u.includes("break_room") || dom.looksBreakRoom || dom.hasContinueReviewing) {
    return {
      kind: "break_room",
      action: "clear_break_room",
      categoryId: cat,
      summary: "Break Room — wait then continue reviewing",
      confidence: 0.95,
    };
  }

  if (u.includes("nocalls.cfm")) {
    return {
      kind: "no_calls",
      action: "wait_empty",
      categoryId: cat,
      summary: `Queue empty (noCalls)${cat ? ` for #${cat}` : ""}`,
      confidence: 0.98,
    };
  }

  // Practice quiz sits on hcat_intro — but if REVIEW CALLS CTA exists, enter live queue
  // immediately (do NOT re-solve practice every visit).
  const practiceText = /practice\s+questions?/i.test(dom.text) || /practice\s+questions?/i.test(dom.heading || "");
  const hasPracticeUi = dom.practiceBlocks >= 1 || (practiceText && dom.radios >= 3);

  if (hasPracticeUi && dom.hasReviewCalls) {
    return {
      kind: "call_intro",
      action: "click_review_calls",
      categoryId: cat,
      summary: `REVIEW CALLS available — skipping practice quiz, entering live queue${cat ? ` (#${cat})` : ""}`,
      confidence: 0.96,
    };
  }

  if (hasPracticeUi) {
    // No live CTA — practice is the only path forward
    if (dom.hasInitialsForm) {
      return {
        kind: "practice_intro",
        action: "complete_practice",
        categoryId: cat,
        summary: `Practice quiz — initials form ready (${dom.practiceDone}/${dom.practiceBlocks} marked)`,
        confidence: 0.94,
      };
    }
    return {
      kind: "practice_intro",
      action: "complete_practice",
      categoryId: cat,
      summary: `Practice required (no REVIEW CALLS yet) — ${dom.practiceBlocks} clips${cat ? ` · cat #${cat}` : ""}`,
      confidence: 0.9,
    };
  }

  if (u.includes("hcat_intro") || u.includes("category_selector") || /\/x19\//i.test(u)) {
    // Live call already on screen (audio and/or radios) — never treat as idle intro
    if (dom.practiceBlocks < 1 && !practiceText) {
      if (dom.radios >= 2 && (dom.audios >= 1 || /submit/i.test(dom.text))) {
        return {
          kind: "live_review",
          action: "review_call",
          categoryId: cat,
          summary: `Live review ready (${dom.radios} options, ${dom.audios} audio)${cat ? ` · #${cat}` : ""}`,
          confidence: 0.93,
        };
      }
      if (dom.audios >= 1) {
        return {
          kind: "live_review",
          action: "hold_call",
          categoryId: cat,
          summary: `Live call audio — listen @2.5x then unlock options (${dom.radios} choices)${cat ? ` · #${cat}` : ""}`,
          confidence: 0.9,
        };
      }
      if (dom.radios >= 3) {
        return {
          kind: "live_review",
          action: "review_call",
          categoryId: cat,
          summary: `Live review options visible (${dom.radios})${cat ? ` · #${cat}` : ""}`,
          confidence: 0.88,
        };
      }
    }

    if (dom.hasReviewCalls && dom.audios < 1 && dom.radios < 2) {
      return {
        kind: "call_intro",
        action: "click_review_calls",
        categoryId: cat,
        summary: `Call intro — REVIEW CALLS available${cat ? ` (#${cat})` : ""}`,
        confidence: 0.9,
      };
    }
    return {
      kind: "call_intro",
      action: "wait",
      categoryId: cat,
      summary: `Call intro settling${cat ? ` (#${cat})` : ""} — waiting for radios / REVIEW CALLS`,
      confidence: 0.75,
    };
  }

  // Live review on other URLs (some queues use odd paths / title "Review")
  if (dom.practiceBlocks < 1 && !practiceText) {
    if (/\/x19\/review\.cfm/i.test(u) || /review\.cfm/i.test(u)) {
      if (dom.radios >= 2) {
        return {
          kind: "live_review",
          action: "hold_call",
          categoryId: cat,
          summary: `Humfun live review (${dom.radios} options, audio=${dom.audios}) — listen then submit`,
          confidence: 0.95,
        };
      }
      return {
        kind: "live_review",
        action: "hold_call",
        categoryId: cat,
        summary: `Humfun review.cfm — listen through call before selecting`,
        confidence: 0.92,
      };
    }
    if (dom.radios >= 2 && (dom.audios >= 1 || /submit/i.test(dom.text))) {
      return {
        kind: "live_review",
        action: "review_call",
        categoryId: cat,
        summary: `Live review (${dom.radios} options)${cat ? ` · #${cat}` : ""}`,
        confidence: 0.9,
      };
    }
    if (dom.audios >= 1) {
      return {
        kind: "live_review",
        action: "hold_call",
        categoryId: cat,
        summary: `Call audio present — holding page until options load (${dom.radios} radios)`,
        confidence: 0.88,
      };
    }
  }

  if (/\/category\.cfm/i.test(u) && !u.includes("hcat=")) {
    return {
      kind: "category_list",
      action: "open_category",
      categoryId: cat,
      summary: "Category list — open target via REVIEW",
      confidence: 0.95,
    };
  }

  if (u.includes("profile.cfm")) {
    return {
      kind: "profile",
      action: "open_category",
      categoryId: cat,
      summary: "Profile page — navigate to category list",
      confidence: 0.9,
    };
  }

  // Title "Review" with no clear chrome — still hold if it looks like a call surface
  if (/review/i.test(dom.title) && (dom.audios >= 1 || dom.radios >= 2 || /submit\s+review/i.test(dom.text))) {
    return {
      kind: "live_review",
      action: dom.radios >= 2 ? "review_call" : "hold_call",
      categoryId: cat,
      summary: `Review page hold (audio=${dom.audios} radios=${dom.radios})`,
      confidence: 0.8,
    };
  }

  return {
    kind: "unknown",
    action: "wait",
    categoryId: cat,
    summary: `Unknown page (${dom.heading || dom.title || "no heading"})`,
    confidence: 0.4,
  };
}

/** Read URL + DOM and return a full scene understanding. */
export async function detectPageScene(page: Page): Promise<PageScene> {
  let url = "";
  try {
    url = page.url();
  } catch {
    url = "";
  }

  let dom: DomSnapshot;
  try {
    dom = await readDom(page);
  } catch (e) {
    return {
      kind: "unknown",
      action: "wait",
      url,
      title: "",
      categoryId: categoryFromUrl(url),
      summary: `DOM unreadable: ${(e as Error).message}`,
      details: {
        heading: null,
        practiceBlocks: 0,
        practiceDone: 0,
        radios: 0,
        radiosChecked: 0,
        audios: 0,
        submitEnabled: false,
        hasInitialsForm: false,
        hasReviewCalls: false,
        hasContinueReviewing: false,
        optionLabels: [],
        bodySnippet: "",
      },
      confidence: 0.1,
    };
  }

  const classified = classify(url, dom);
  return {
    ...classified,
    url,
    title: dom.title,
    details: {
      heading: dom.heading,
      practiceBlocks: dom.practiceBlocks,
      practiceDone: dom.practiceDone,
      radios: dom.radios,
      radiosChecked: dom.radiosChecked,
      audios: dom.audios,
      submitEnabled: dom.submitEnabled,
      hasInitialsForm: dom.hasInitialsForm,
      hasReviewCalls: dom.hasReviewCalls,
      hasContinueReviewing: dom.hasContinueReviewing,
      optionLabels: dom.optionLabels,
      bodySnippet: dom.text.slice(0, 220),
    },
  };
}

export function formatSceneLog(scene: PageScene): string {
  const d = scene.details;
  return (
    `[scene] ${scene.kind} → ${scene.action} (${Math.round(scene.confidence * 100)}%) | ${scene.summary}` +
    ` | practice=${d.practiceBlocks}/${d.practiceDone} radios=${d.radios} audio=${d.audios}` +
    ` submit=${d.submitEnabled ? "on" : "off"} initials=${d.hasInitialsForm} reviewCalls=${d.hasReviewCalls}`
  );
}
