/**
 * Rotating Groq/xAI API keys (GROK_API_KEY + KEY2 + KEY3).
 * On 429 / auth failure, advance to the next key.
 */
import { config } from "./config";

const keys = (): string[] =>
  [config.grokApiKey, config.grokApiKey2, config.grokApiKey3].filter(
    (k, i, a) => !!k && a.indexOf(k) === i,
  );

let index = 0;

export const currentGrokApiKey = (): string => {
  const list = keys();
  if (!list.length) return "";
  return list[index % list.length];
};

export const rotateGrokApiKey = (reason = "rate-limit"): string => {
  const list = keys();
  if (list.length < 2) return currentGrokApiKey();
  index = (index + 1) % list.length;
  console.warn(`[keys] Rotated Groq key → slot ${index + 1}/${list.length} (${reason})`);
  return list[index];
};

export const grokKeyCount = (): number => keys().length;

export const grokKeySlotLabel = (): string => {
  const list = keys();
  if (!list.length) return "none";
  return `${(index % list.length) + 1}/${list.length}`;
};
