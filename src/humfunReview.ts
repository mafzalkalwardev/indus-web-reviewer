/**
 * Humanatic live review UI on /x19/review.cfm
 * Uses .humfun-options-list-item cards (NOT input[type=radio]).
 * Options stay locked until the recording has been listened through.
 */
import { Page } from "playwright";
import { ReviewOption } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type HumfunAudioState = {
  present: boolean;
  paused: boolean;
  ended: boolean;
  current: number;
  duration: number;
  rate: number;
};

export const isHumfunReviewPage = async (page: Page): Promise<boolean> => {
  const url = page.url().toLowerCase();
  if (url.includes("/x19/review.cfm") || url.includes("review.cfm")) return true;
  return page
    .evaluate(() => document.querySelectorAll(".humfun-options-list-item").length >= 2)
    .catch(() => false);
};

export const countHumfunOptions = async (page: Page): Promise<number> => {
  return page.locator(".humfun-options-list-item").count().catch(() => 0);
};

export const readHumfunOptions = async (page: Page): Promise<ReviewOption[]> => {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll(".humfun-options-list-item")).map((el, index) => {
      const hco = (el.querySelector(".humfun-options-list-item-hco")?.textContent || "").trim();
      const label = (
        el.querySelector(".humfun-options-list-item-text")?.textContent ||
        el.textContent ||
        ""
      )
        .replace(/\s+/g, " ")
        .replace(/^\d+\s*/, "")
        .trim();
      const id = hco || `humfun-opt-${index}`;
      return {
        id,
        label: label || `Option ${index + 1}`,
        criteria: label || `Option ${index + 1}`,
        value: hco || undefined,
      };
    });
  });
};

/**
 * True when Humanatic still blocks selection (must finish listening).
 *
 * Do NOT scan full body text — tip/"i" copy like "Selections will be available…"
 * and "Retrieving call from server…" stay in the DOM after unlock and were
 * falsely keeping us forever on "still locked".
 */
export const optionsStillLocked = async (page: Page): Promise<boolean> => {
  return page.evaluate(() => {
    const isVisible = (el: HTMLElement | null): boolean => {
      if (!el) return false;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      if (Number(st.opacity || "1") < 0.08) return false;
      return el.offsetHeight > 8 && el.offsetWidth > 8;
    };

    // Primary lock overlay Humanatic uses while listening
    const inactive = document.querySelector(".humfun-options-list-inactive") as HTMLElement | null;
    if (isVisible(inactive)) return true;

    // Positive unlock signal: clickable option cards
    const items = Array.from(
      document.querySelectorAll(".humfun-options-list-item"),
    ) as HTMLElement[];
    if (items.length >= 2) {
      const clickable = items.filter((el) => {
        const st = getComputedStyle(el);
        if (st.pointerEvents === "none") return false;
        if (Number(st.opacity || "1") < 0.35) return false;
        if (el.classList.contains("disabled") || el.getAttribute("aria-disabled") === "true") {
          return false;
        }
        return true;
      });
      if (clickable.length >= 2 && !isVisible(inactive)) return false;
    }

    // Narrow: only SHORT visible nodes whose own text is the lock banner
    // (skips large ancestors that merely contain leftover tip text).
    const candidates = Array.from(
      document.querySelectorAll("div, span, p, strong, em, label"),
    ) as HTMLElement[];
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length < 8 || t.length > 90) continue;
      if (/^selections will be available/i.test(t)) return true;
      if (/^retrieving call from server/i.test(t)) return true;
    }

    return false;
  });
};

export const getAudioState = async (page: Page): Promise<HumfunAudioState> => {
  return page.evaluate(() => {
    const audio = document.querySelector("audio") as HTMLAudioElement | null;
    if (!audio) {
      return { present: false, paused: true, ended: false, current: 0, duration: 0, rate: 1 };
    }
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const ended =
      audio.ended || (duration > 0 && current >= duration - 0.35);
    return {
      present: true,
      paused: audio.paused,
      ended,
      current,
      duration,
      rate: audio.playbackRate || 1,
    };
  });
};

/**
 * Play the call through at speed (default 2.5x). Humanatic requires a full listen
 * before options unlock — speeding up is allowed; skipping is not.
 * Playback is muted by default so the laptop stays quiet (Whisper uses the audio URL).
 */
export const listenThroughCall = async (
  page: Page,
  opts: {
    playbackRate?: number;
    onProgress?: (msg: string) => void;
    timeoutMs?: number;
    /** Static mute, or live getter (Watch & listen can flip mid-call). */
    muted?: boolean | (() => boolean);
  } = {},
): Promise<"done" | "no_audio" | "timeout"> => {
  const rate = opts.playbackRate ?? Number(process.env.REVIEW_PLAYBACK_RATE || "2.5");
  const isMuted = () =>
    typeof opts.muted === "function" ? !!opts.muted() : (opts.muted ?? (process.env.MUTE_CALL_AUDIO || "1") !== "0");
  const timeoutMs = opts.timeoutMs ?? 180000;
  const deadline = Date.now() + timeoutMs;

  let state = await getAudioState(page);
  if (!state.present) return "no_audio";
  if (state.ended) return "done";

  const startPlay = async () => {
    const mute = isMuted();
    await page.evaluate(
      ({ r, mute: m }: { r: number; mute: boolean }) => {
        const audio = document.querySelector("audio") as HTMLAudioElement | null;
        if (!audio) return;
        audio.playbackRate = Math.min(3, Math.max(1, r));
        audio.muted = m;
        audio.volume = m ? 0 : 1;
        const p = audio.play();
        if (p && typeof (p as Promise<void>).catch === "function") {
          (p as Promise<void>).catch(() => undefined);
        }
      },
      { r: rate, mute },
    );
  };

  await startPlay();

  let lastProgressAt = 0;
  const emitProgress = (msg: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 12_000) return;
    lastProgressAt = now;
    opts.onProgress?.(msg);
  };

  emitProgress(
    `Listening ${isMuted() ? "(muted) " : ""}@ ${rate}x (${Math.round(state.current)}s / ${Math.round(state.duration || 0)}s)`,
    true,
  );

  let muteEnforceTick = 0;
  while (Date.now() < deadline) {
    state = await getAudioState(page);
    if (!state.present) return "no_audio";
    if (state.ended) {
      emitProgress("Recording finished — waiting for options to unlock…", true);
      return "done";
    }
    if (state.paused) {
      await startPlay();
    } else {
      muteEnforceTick += 1;
      if (muteEnforceTick % 2 === 0) {
        const mute = isMuted();
        await page.evaluate((m) => {
          const audio = document.querySelector("audio") as HTMLAudioElement | null;
          if (!audio) return;
          audio.muted = m;
          audio.volume = m ? 0 : 1;
        }, mute);
      }
    }
    emitProgress(
      `Listening${isMuted() ? " (muted)" : ""} @ ${state.rate.toFixed(1)}x — ${Math.round(state.current)}s / ${Math.round(state.duration || 0)}s`,
    );
    await sleep(2500);
  }
  return "timeout";
};

/** After audio ends, wait until Humanatic unlocks the option list. */
export const waitUntilOptionsUnlocked = async (
  page: Page,
  timeoutMs = 45000,
  onProgress?: (msg: string) => void,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await countHumfunOptions(page);
    const locked = await optionsStillLocked(page);
    if (n >= 2 && !locked) {
      onProgress?.(`Options unlocked (${n} choices)`);
      return true;
    }
    onProgress?.(
      locked
        ? `Waiting for options unlock (${n} items, still locked)…`
        : `Waiting for option list (${n} items)…`,
    );
    await sleep(1200);
  }
  // Soft success if items exist even if banner text lingers
  const n = await countHumfunOptions(page);
  return n >= 2;
};

export const selectAndSubmitHumfun = async (
  page: Page,
  optionId: string,
): Promise<"submitted" | "navigated"> => {
  // Prefer Playwright locators so navigation after submit doesn't kill the flow
  const items = page.locator(".humfun-options-list-item");
  const count = await items.count().catch(() => 0);
  let targetIdx = -1;
  for (let i = 0; i < count; i++) {
    const hco = (
      await items
        .nth(i)
        .locator(".humfun-options-list-item-hco")
        .innerText()
        .catch(() => "")
    ).trim();
    if (hco === optionId) {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx < 0) {
    // Fallback: match by evaluate id / index key
    const found = await page
      .evaluate((id) => {
        const list = Array.from(document.querySelectorAll(".humfun-options-list-item"));
        const idx = list.findIndex((el) => {
          const hco = (el.querySelector(".humfun-options-list-item-hco")?.textContent || "").trim();
          return hco === id || el.id === id;
        });
        return idx;
      }, optionId)
      .catch(() => -1);
    targetIdx = found;
  }
  if (targetIdx < 0) throw new Error(`Humfun option not found: ${optionId}`);

  const item = items.nth(targetIdx);
  await item.scrollIntoViewIfNeeded().catch(() => undefined);
  await item.click({ timeout: 8000 });
  await sleep(350);

  await page
    .evaluate((id) => {
      const send = document.querySelector("#sendThis") as HTMLInputElement | null;
      if (send) send.value = id;
    }, optionId)
    .catch(() => undefined);

  const rowSubmit = item.locator(".humfun-options-list-item-submit-btn").first();
  if ((await rowSubmit.count().catch(() => 0)) > 0) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
      rowSubmit.click({ timeout: 8000 }),
    ]);
    await sleep(800);
    if (!/review\.cfm/i.test(page.url())) return "navigated";
  }

  // Global SUBMIT only if still on the review page
  if (/review\.cfm/i.test(page.url())) {
    try {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLElement>(
            "button, input[type='submit'], a, [role='button']",
          ),
        );
        const submit = buttons.find((b) => {
          const t = `${(b as HTMLElement).innerText || ""} ${(b as HTMLInputElement).value || ""}`.trim();
          return /^submit$/i.test(t) || t.toUpperCase() === "SUBMIT";
        });
        if (!submit) return false;
        submit.click();
        return true;
      });
      if (clicked) {
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await sleep(1200);
      }
    } catch (e) {
      // Row submit often navigates away — that is success, not failure
      const msg = (e as Error).message || "";
      if (/Execution context was destroyed|Target closed|navigation/i.test(msg)) {
        return "navigated";
      }
      throw e;
    }
  }

  return /review\.cfm/i.test(page.url()) ? "submitted" : "navigated";
};
