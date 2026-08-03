import OpenAI from "openai";
import { GrokDecision, CategoryRule } from "./types";
import { config } from "./config";
import { parseJsonFromText } from "./utils";

let client: OpenAI | undefined;

const getClient = (): OpenAI => {
  if (!config.grokApiKey) {
    throw new Error("Missing required environment variable: GROK_API_KEY");
  }
  if (!client) {
    client = new OpenAI({ apiKey: config.grokApiKey, baseURL: config.grokBaseUrl });
  }
  return client;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

const callViaResponsesApi = async (prompt: string): Promise<string> => {
  const api = getClient() as OpenAI & {
    responses?: { create: (body: Record<string, unknown>) => Promise<unknown> };
  };
  if (!api.responses?.create) {
    throw new Error("responses API not available on client");
  }
  const response = await api.responses.create({
    model: config.grokModel,
    input: prompt,
    max_output_tokens: 512,
  });
  return extractDecisionText(response);
};

const callViaChatCompletions = async (prompt: string): Promise<string> => {
  const response = await getClient().chat.completions.create({
    model: config.grokModel,
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

export const evaluateTranscript = async (
  category: CategoryRule,
  transcript: string,
): Promise<GrokDecision> => {
  const prompt = buildPrompt(category, transcript);

  let attempt = 0;
  let backoffMs = config.initialBackoffMs;
  let lastError: unknown;

  while (attempt < config.maxGrokRetries) {
    try {
      let text: string;
      try {
        text = await callViaResponsesApi(prompt);
      } catch (responsesErr) {
        console.warn(
          `[grok] responses API failed (${(responsesErr as Error).message}); falling back to chat.completions`,
        );
        text = await callViaChatCompletions(prompt);
      }

      const decision = parseJsonFromText<GrokDecision>(text);
      if (!decision.selected_option_id) {
        throw new Error(`Grok response missing selected_option_id: ${text}`);
      }
      if (typeof decision.confidence !== "number") {
        decision.confidence = Number(decision.confidence) || 0;
      }
      return decision;
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt >= config.maxGrokRetries) break;
      console.warn(`[grok] Attempt ${attempt} failed: ${(error as Error).message}`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, config.maxBackoffMs);
    }
  }

  throw new Error(`Grok evaluation failed after ${config.maxGrokRetries} attempts: ${lastError}`);
};
