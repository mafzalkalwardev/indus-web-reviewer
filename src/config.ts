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
  grokBaseUrl: resolveGrokBaseUrl(),
  grokModel: resolveGrokModel(),
  confidenceThreshold: Number(process.env.CONFIDENCE_THRESHOLD || "0.85"),
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
} as const;

export type AppConfig = typeof config;
