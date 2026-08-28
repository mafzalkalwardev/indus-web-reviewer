/**
 * Quick Groq health check for GROK_API_KEY + GROK_API_KEY2 (no full secrets printed).
 *   npx ts-node scripts/check-groq.ts
 */
import { config } from "../src/config";
import {
  currentGrokApiKey,
  rotateGrokApiKey,
  grokKeyCount,
  grokKeySlotLabel,
} from "../src/grokKeys";

async function probe(key: string, label: string) {
  const models = [config.grokModel, config.grokFallbackModel].filter(
    (m, i, a) => !!m && a.indexOf(m) === i,
  );
  let anyOk = false;
  for (const model of models) {
    try {
      const res = await fetch(`${config.grokBaseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "Reply with valid JSON only." },
            {
              role: "user",
              content:
                '{"selected_option_id":"ping","reasoning":"healthcheck","confidence":0.99}',
            },
          ],
          temperature: 0,
          max_tokens: 80,
          response_format: { type: "json_object" },
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        console.error(
          `[groq] ${label} ${model} HTTP ${res.status} — ${text.replace(/\s+/g, " ").slice(0, 160)}`,
        );
        continue;
      }
      console.log(`[groq] OK — ${label} ${model}`);
      anyOk = true;
    } catch (e) {
      console.error(`[groq] ${label} ${model} error: ${(e as Error).message}`);
    }
  }
  return anyOk;
}

async function main() {
  console.log(`[groq] base=${config.grokBaseUrl} keysConfigured=${grokKeyCount()}`);
  if (!grokKeyCount()) {
    console.error("[groq] FAIL — set GROK_API_KEY and/or GROK_API_KEY2");
    process.exit(1);
  }
  let ok = false;
  for (let i = 0; i < grokKeyCount(); i++) {
    const key = currentGrokApiKey();
    const label = `slot ${grokKeySlotLabel()} (${key.slice(0, 7)}…)`;
    if (await probe(key, label)) ok = true;
    if (grokKeyCount() > 1) rotateGrokApiKey("healthcheck");
  }
  if (!ok) {
    console.error("[groq] FAIL — no key responded");
    process.exit(1);
  }
  console.log("[groq] Health check passed (including key rotation)");
}

main();
