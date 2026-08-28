import OpenAI from "openai";
import { GrokDecision, CategoryRule } from "./types";
import { config } from "./config";
import { parseJsonFromText } from "./utils";
import { heuristicDecide, parseRateLimitWaitMs } from "./heuristicDecision";
import { currentGrokApiKey, rotateGrokApiKey, grokKeySlotLabel } from "./grokKeys";

let client: OpenAI | undefined;
let clientKey = "";
/** While Date.now() < this, skip LLM and use heuristic only (rate-limit cool-down). */
let llmCooldownUntil = 0;

const getClient = (): OpenAI => {
  const key = currentGrokApiKey();
  if (!key) {
    throw new Error("Missing GROK_API_KEY / GROK_API_KEY2");
  }
  if (!client || clientKey !== key) {
    client = new OpenAI({ apiKey: key, baseURL: config.grokBaseUrl });
    clientKey = key;
    console.log(`[grok] Using API key slot ${grokKeySlotLabel()}`);
  }
  return client;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimitError = (err: unknown): boolean => {
  const msg = (err as Error)?.message || String(err || "");
  const status = (err as { status?: number })?.status;
  return status === 429 || /429|rate limit|tokens per day|TPD/i.test(msg);
};

const armCooldownFromError = (err: unknown): void => {
  const msg = (err as Error)?.message || String(err || "");
  const wait = parseRateLimitWaitMs(msg);
  if (wait != null) {
    // Cap cool-down; don't park for 15m without working — heuristic covers meanwhile
    const ms = Math.min(Math.max(wait, 15_000), 120_000);
    llmCooldownUntil = Math.max(llmCooldownUntil, Date.now() + ms);
    console.warn(`[grok] Rate-limit cool-down ${Math.round(ms / 1000)}s — using heuristic until then`);
  }
};

export const getLlmCooldownRemainingMs = (): number => Math.max(0, llmCooldownUntil - Date.now());

const buildPrompt = (category: CategoryRule, transcript: string): string => {
  const optionsJson = JSON.stringify(category.options, null, 2);
  return `You are an expert call reviewer. Analyze the call transcript against the provided category rules and selection options.

Category: ${category.category_name} (${category.category_id})

Category Rules:
${category.rules}

Available Options (you MUST pick selected_option_id from these exact id values):
${optionsJson}

Transcript:
${transcript}

Task:
1. Translate foreign speech if present.
2. Compare call intent with the category criteria.
3. Select the single correct option ID from the list above.

CRITICAL accuracy rules (Humanatic audits these hard — bad submits cost ¢ AND rank):
- Prefer "Not handled: …" when the call is hold-only, early hang-up, wrong number, spam, voicemail without a resolved live conversation, or nobody answers.
- Only pick "Handled by a qualified employee or interactive system" when there is CLEAR evidence of a live agent OR a real interactive menu that handled the caller (not just a greeting / "thank you").
- Short transcripts like only "Thank you" are NOT enough for Handled — set confidence ≤ 0.7 or pick the matching Not handled option.
- If unsure between Handled vs Not handled, choose Not handled and set confidence ≤ 0.75 rather than guessing Handled.
- If the transcript is garbled, too short, or options don't clearly fit, set confidence ≤ 0.65 (the bot will skip — that protects accuracy).
- Never invent details that are not in the transcript.

Inbound Handled vs Not-handled (most common audit failures — follow strictly):
- Handled REQUIRES: audible two-way talk with a human agent, OR a working IVR/menu that clearly routes/collects info (press 1, account prompts, transfer to a queue with interaction). A ringtone + hangup is NOT handled.
- Choose Not handled (nobody / wrong number / spam) when: silence, dead air, instant hangup, bridge fail, fax, "the number you have dialed…", or no agent ever speaks.
- Choose Not handled (ended on hold) when: hold music / "please hold" then call ends with NO agent conversation afterward.
- Choose Not handled (live conversation but no live message left) when: voicemail/greeting plays and caller does not leave a real actionable message, OR brief outbound attempt with no meaningful live exchange.
- If you only hear a short IVR greeting then disconnect with no menu choices completed → Not handled, NOT Handled.
- "Thank you for calling" alone is never enough for Handled.

Return strictly valid JSON:
{
  "selected_option_id": "string",
  "reasoning": "string",
  "confidence": number
}
`;
};

const extractDecisionText = (response: unknown): string => {
  const anyResp = response as {
    output_text?: string;
    output?: unknown;
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };

  if (typeof anyResp.output_text === "string" && anyResp.output_text.trim()) {
    return anyResp.output_text;
  }

  if (Array.isArray(anyResp.output)) {
    return anyResp.output
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join("\n");
  }

  if (typeof anyResp.output === "string") {
    return anyResp.output;
  }

  const choice = anyResp.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice;
  if (Array.isArray(choice)) {
    return choice.map((c) => c.text || "").join("\n");
  }

  return JSON.stringify(response);
};

const callViaChatCompletions = async (prompt: string, model: string): Promise<string> => {
  const response = await getClient().chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: "You are an expert call reviewer. Respond with valid JSON only.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 512,
    response_format: { type: "json_object" },
  });
  return extractDecisionText(response);
};

const callViaResponsesApi = async (prompt: string, model: string): Promise<string> => {
  const api = getClient() as OpenAI & {
    responses?: { create: (body: Record<string, unknown>) => Promise<unknown> };
  };
  if (!api.responses?.create) {
    throw new Error("responses API not available on client");
  }
  const response = await api.responses.create({
    model,
    input: prompt,
    max_output_tokens: 512,
  });
  return extractDecisionText(response);
};

const parseDecision = (text: string): GrokDecision => {
  const decision = parseJsonFromText<GrokDecision>(text);
  if (!decision.selected_option_id) {
    throw new Error(`Grok response missing selected_option_id: ${text}`);
  }
  if (typeof decision.confidence !== "number") {
    decision.confidence = Number(decision.confidence) || 0;
  }
  decision.source = "llm";
  return decision;
};

const callModelOnce = async (prompt: string, model: string): Promise<GrokDecision> => {
  try {
    const text = await callViaChatCompletions(prompt, model);
    return parseDecision(text);
  } catch (chatErr) {
    if (isRateLimitError(chatErr)) throw chatErr;
    // Try responses API as alternate shape
    try {
      const text = await callViaResponsesApi(prompt, model);
      return parseDecision(text);
    } catch (respErr) {
      if (isRateLimitError(respErr)) throw respErr;
      throw chatErr;
    }
  }
};

export const evaluateTranscript = async (
  category: CategoryRule,
  transcript: string,
): Promise<GrokDecision> => {
  const prompt = buildPrompt(category, transcript);

  // Cool-down active → skip LLM entirely (stop 429 spam / skipped_error loops)
  if (Date.now() < llmCooldownUntil) {
    const local = heuristicDecide(category, transcript);
    if (local) {
      console.warn(
        `[grok] Using heuristic during cool-down (${Math.ceil(getLlmCooldownRemainingMs() / 1000)}s left)`,
      );
      return local;
    }
  }

  let lastError: unknown;
  const models = [config.grokModel, config.grokFallbackModel].filter(
    (m, i, arr) => !!m && arr.indexOf(m) === i,
  );

  for (const model of models) {
    let attempt = 0;
    let backoffMs = config.initialBackoffMs;
    while (attempt < Math.min(2, config.maxGrokRetries)) {
      try {
        console.log(`[grok] decide via ${model} (attempt ${attempt + 1})`);
        return await callModelOnce(prompt, model);
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (isRateLimitError(error)) {
          armCooldownFromError(error);
          rotateGrokApiKey("llm-429");
          // Clear cool-down briefly so rotated key can try
          llmCooldownUntil = Math.min(llmCooldownUntil, Date.now() + 5_000);
          console.warn(`[grok] ${model} rate-limited — rotated key, try next model`);
          break; // next model
        }
        console.warn(`[grok] Attempt ${attempt} failed on ${model}: ${(error as Error).message}`);
        if (attempt >= Math.min(2, config.maxGrokRetries)) break;
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, config.maxBackoffMs);
      }
    }
  }

  const local = heuristicDecide(category, transcript);
  if (local) {
    console.warn(`[grok] LLM failed — heuristic decision: ${local.selected_option_id}`);
    return local;
  }

  throw new Error(
    `Grok evaluation failed after retries: ${lastError instanceof Error ? lastError.message : lastError}`,
  );
};
