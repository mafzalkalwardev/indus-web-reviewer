/**
 * Offline decision when Groq/LLM is unavailable (rate limits, outages).
 * Scores live option labels against transcript keywords.
 */
import { CategoryRule, GrokDecision, ReviewOption } from "./types";

type Rule = { re: RegExp; weight: number };

const HANDLED_RULES: Rule[] = [
  { re: /\b(hello|hi|thank you for calling|how can i help|my name is|this is)\b/i, weight: 2 },
  { re: /\b(transfer|connect(ing)? you|please hold|representative|department)\b/i, weight: 2 },
  { re: /\b(ivr|press\s+\d|interactive|menu)\b/i, weight: 2 },
  { re: /\b(spoke with|talked to|agent|specialist|advisor)\b/i, weight: 3 },
];

const VM_RULES: Rule[] = [
  { re: /\b(voicemail|voice mail|leave a message|after the (beep|tone)|mailbox)\b/i, weight: 4 },
  { re: /\b(not available|unable to take your call|record your message)\b/i, weight: 3 },
];

const NOBODY_RULES: Rule[] = [
  { re: /\b(nobody|no one|no answer|doesn't answer|did not answer|hung up|hang up)\b/i, weight: 3 },
  { re: /\b(wrong number|spam|robocall|dead air|silence)\b/i, weight: 3 },
  { re: /\b(bridge|disconnected|dropped)\b/i, weight: 2 },
];

const HOLD_END_RULES: Rule[] = [
  { re: /\b(on hold|please hold|hold music|ended while on hold|still holding)\b/i, weight: 3 },
  { re: /\b(call (was )?disconnected|line (went )?dead)\b/i, weight: 2 },
];

function scoreRules(text: string, rules: Rule[]): number {
  return rules.reduce((sum, r) => (r.re.test(text) ? sum + r.weight : sum), 0);
}

function scoreOption(label: string, transcript: string): number {
  const L = label.toLowerCase();
  const t = transcript.toLowerCase();
  let score = 0;

  // Label-token overlap with transcript
  const tokens = L.replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !/^(handled|not|with|from|that|this|call|the)$/.test(w));
  for (const tok of tokens) {
    if (t.includes(tok)) score += 1.2;
  }

  if (/qualified employee|interactive system|handled by/i.test(label)) {
    score += scoreRules(transcript, HANDLED_RULES);
    // Strong penalties — "Handled" was over-selected and failed audits
    score -= scoreRules(transcript, VM_RULES) * 2.2;
    score -= scoreRules(transcript, NOBODY_RULES) * 2.0;
    score -= scoreRules(transcript, HOLD_END_RULES) * 1.8;
    if (/^(thank you[.!]?\s*)+$/i.test(transcript.trim()) || transcript.trim().length < 60) {
      score -= 6;
    }
    // Need clear interaction evidence; greeting alone is not enough
    if (!/\b(press\s+\d|how can i help|my name is|account number|transfer|spoke with|representative)\b/i.test(transcript)) {
      score -= 3;
    }
  }
  if (/voicemail|left message/i.test(label)) {
    score += scoreRules(transcript, VM_RULES);
  }
  if (/nobody|hung up|wrong number|spam|bridge/i.test(label)) {
    score += scoreRules(transcript, NOBODY_RULES);
  }
  if (/on hold/i.test(label)) {
    score += scoreRules(transcript, HOLD_END_RULES);
  }
  if (/:\s*other\b/i.test(label) || /not handled:\s*other/i.test(label)) {
    // Prefer only as weak default
    score += 0.4;
  }

  return score;
}

function pickBest(options: ReviewOption[], transcript: string): { opt: ReviewOption; score: number } | null {
  if (!options.length) return null;
  let best: ReviewOption | null = null;
  let bestScore = -Infinity;
  for (const opt of options) {
    const s = scoreOption(opt.label || opt.criteria || "", transcript);
    if (s > bestScore) {
      bestScore = s;
      best = opt;
    }
  }
  return best ? { opt: best, score: bestScore } : null;
}

/**
 * Returns a best-effort decision when the LLM is down.
 *
 * Confidence here is deliberately BELOW config.confidenceThreshold. These are
 * keyword guesses, not model judgements; the previous 0.88/0.86 values sat just
 * above the 0.85 gate, which meant the gate could never reject them. Callers
 * that genuinely want to act on heuristics must opt in via HEURISTIC_SUBMIT=1,
 * which checks `source` rather than second-guessing the number.
 */
export function heuristicDecide(category: CategoryRule, transcript: string): GrokDecision | null {
  const text = (transcript || "").trim();
  if (!category.options?.length) return null;

  const picked = pickBest(category.options, text);
  if (!picked) return null;

  // Strong keyword hit
  if (picked.score >= 3) {
    return {
      selected_option_id: picked.opt.id,
      confidence: 0.6,
      source: "heuristic",
      reasoning: `[heuristic] Matched "${picked.opt.label}" (score=${picked.score.toFixed(1)}) while LLM unavailable`,
    };
  }

  // Weak but better than nothing — only for live continuation under rate limits
  if (picked.score >= 1.5 || text.length < 40) {
    // Very short / empty transcript: prefer common "not handled: other" or nobody / first Not handled
    let opt = picked.opt;
    if (text.length < 40) {
      const fallback =
        category.options.find((o) => /nobody there|wrong number|spam/i.test(o.label)) ||
        category.options.find((o) => /not handled:\s*other/i.test(o.label)) ||
        category.options.find((o) => /not handled/i.test(o.label)) ||
        picked.opt;
      opt = fallback;
    }
    return {
      selected_option_id: opt.id,
      confidence: 0.4,
      source: "heuristic",
      reasoning: `[heuristic-fallback] LLM rate-limited; chose "${opt.label}" (score=${picked.score.toFixed(1)}, transcriptLen=${text.length})`,
    };
  }

  return null;
}

/** Parse Groq "Please try again in 14m11.04s" → milliseconds */
export function parseRateLimitWaitMs(message: string): number | null {
  const m = message.match(/try again in\s+(\d+)m([\d.]+)s/i);
  if (m) {
    return (Number(m[1]) * 60 + Number(m[2])) * 1000;
  }
  const s = message.match(/try again in\s+([\d.]+)s/i);
  if (s) return Number(s[1]) * 1000;
  if (/429|rate limit|TPD|tokens per day/i.test(message)) return 60_000;
  return null;
}
