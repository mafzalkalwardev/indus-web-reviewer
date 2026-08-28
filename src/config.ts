import dotenv from "dotenv";

dotenv.config();

const getEnv = (key: string, fallback?: string): string => {
  const value = process.env[key] || fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

/** Infer OpenAI-compatible base URL from key prefix when GROK_BASE_URL is unset. */
const resolveGrokBaseUrl = (): string => {
  if (process.env.GROK_BASE_URL?.trim()) return process.env.GROK_BASE_URL.trim();
  const key = process.env.GROK_API_KEY || "";
  // Groq keys are typically gsk_… and use the OpenAI-compatible endpoint below.
  if (key.startsWith("gsk_")) return "https://api.groq.com/openai/v1";
  return "https://api.x.ai/v1";
};

const resolveGrokModel = (): string => {
  if (process.env.GROK_MODEL?.trim()) return process.env.GROK_MODEL.trim();
  const key = process.env.GROK_API_KEY || "";
  if (key.startsWith("gsk_")) return "llama-3.3-70b-versatile";
  return "grok-4-fast-non-reasoning";
};

export const config = {
  humanaticBaseUrl: getEnv(
    "HUMANATIC_BASE_URL",
    "https://www.humanatic.com/pages/humfun/login.cfm",
  ),
  /** Optional direct review-queue URL after login. Empty = use post-login redirect + in-app nav. */
  humanaticReviewUrl: process.env.HUMANATIC_REVIEW_URL || "",
  authStatePath: getEnv("HUMANATIC_AUTH_STATE", ".auth/humanatic.json"),
  browserProfilePath: getEnv("HUMANATIC_BROWSER_PROFILE", ".browser-profile"),
  grokApiKey: process.env.GROK_API_KEY || "",
  /** Fresh secondary Groq/xAI key — rotated on 429 / failures. */
  grokApiKey2: process.env.GROK_API_KEY2 || "",
  /** Third Groq account — more Whisper/LLM quota headroom. */
  grokApiKey3: process.env.GROK_API_KEY3 || "",
  grokBaseUrl: resolveGrokBaseUrl(),
  grokModel: resolveGrokModel(),
  /** Cheaper/faster model tried when primary hits rate limits (often separate TPD quota). */
  grokFallbackModel:
    process.env.GROK_FALLBACK_MODEL?.trim() ||
    ((process.env.GROK_API_KEY || process.env.GROK_API_KEY2 || process.env.GROK_API_KEY3 || "").startsWith(
      "gsk_",
    )
      ? "llama-3.1-8b-instant"
      : ""),
  /** Free STT providers (preferred over paid OpenAI). */
  deepgramApiKey: process.env.DEEPGRAM_API_KEY || "",
  assemblyAiApiKey: process.env.ASSEMBLYAI_API_KEY || "",
  /** Optional Gemini — reserved for future 2nd-opinion LLM (not required). */
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  /**
   * Accuracy-first mode (default on): stricter skip gate + category pick by
   * expected value (payout × site accuracy) so we chase high ¢ without bleeding audits.
   */
  accuracyFirst: (process.env.ACCURACY_FIRST || "1") !== "0",
  confidenceThreshold: (() => {
    const raw = Number(process.env.CONFIDENCE_THRESHOLD || "0.85");
    const accuracyFirst = (process.env.ACCURACY_FIRST || "1") !== "0";
    // Soft floor when accuracy-first — allow volume mode at 0.88
    if (accuracyFirst) return Math.max(raw, 0.85);
    return raw;
  })(),
  /**
   * Allow keyword-heuristic decisions (used when the LLM is rate-limited) to be
   * SUBMITTED live. Off by default: the heuristic previously returned a
   * hardcoded 0.88 against a 0.85 threshold, which made the confidence gate
   * impossible to fail and shipped guesses to a live account.
   */
  heuristicSubmit: (process.env.HEURISTIC_SUBMIT || "0") === "1",
  maxGrokRetries: Number(process.env.MAX_GROK_RETRIES || "3"),
  initialBackoffMs: Number(process.env.INITIAL_BACKOFF_MS || "1000"),
  maxBackoffMs: Number(process.env.MAX_BACKOFF_MS || "16000"),
  turnstileTimeoutMs: Number(process.env.TURNSTILE_TIMEOUT_MS || "120000"),
  turnstilePollMs: Number(process.env.TURNSTILE_POLL_MS || "1000"),
  browserWidth: Number(process.env.BROWSER_WIDTH || "1440"),
  browserHeight: Number(process.env.BROWSER_HEIGHT || "900"),
  /** Safety cap for continuous review loop. */
  maxReviewCalls: Number(process.env.MAX_REVIEW_CALLS || "50"),
  /** Stop when no next call appears for this long (ms). */
  reviewIdleTimeoutMs: Number(process.env.REVIEW_IDLE_TIMEOUT_MS || "90000"),
  /** How long to wait for manual login on first run (ms). */
  loginWaitTimeoutMs: Number(process.env.LOGIN_WAIT_TIMEOUT_MS || "600000"),
  /**
   * Optional: use an existing Chrome install profile (better Cloudflare trust).
   * Example: %LOCALAPPDATA%\Google\Chrome\User Data + profileDirectory=Default
   */
  chromeUserDataDir: process.env.CHROME_USER_DATA_DIR || "",
  chromeProfileDirectory: process.env.CHROME_PROFILE_DIRECTORY || "Default",
  chromeDebugPort: Number(process.env.CHROME_DEBUG_PORT || "9222"),
  /** When using a real Chrome profile, skip anti-detection injection (default true). */
  skipAntiDetection: (process.env.SKIP_ANTI_DETECTION || "1") !== "0",
  /** Humanatic login credentials (optional — enables automatic form login). */
  humanaticUsername: process.env.HUMANATIC_USERNAME || process.env.HUMANATIC_EMAIL || "",
  humanaticPassword: process.env.HUMANATIC_PASSWORD || "",
  /**
   * Practice mode: run Grok + select the radio, but do NOT click Submit.
   * Set PRACTICE_MODE=0 only when ready for live audits.
   */
  practiceMode: (process.env.PRACTICE_MODE || "1") !== "0",
  /**
   * Mute call <audio> while it still plays through (Humanatic unlock).
   * Whisper downloads the recording URL — speakers stay silent so you can work.
   */
  muteCallAudio: (process.env.MUTE_CALL_AUDIO || "1") !== "0",
  /** Start / keep automation Chrome minimized (don't steal focus). */
  backgroundChrome: (process.env.BACKGROUND_CHROME || "1") !== "0",
  reviewPlaybackRate: Number(
    process.env.REVIEW_PLAYBACK_RATE ||
      ((process.env.ACCURACY_FIRST || "1") !== "0" ? "2.0" : "2.5"),
  ),
} as const;

export type AppConfig = typeof config;
