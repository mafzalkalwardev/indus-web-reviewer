/**
 * Free multi-provider speech-to-text for call audio.
 * Order: Deepgram (phone-optimized) → AssemblyAI (free hours) → Groq Whisper (3 keys).
 * OpenAI is intentionally NOT used (paid-on-use).
 */
import { config } from "./config";
import { transcribeWithGroqWhisper, getWhisperCooldownRemainingMs, isWhisperCircuitOpen } from "./whisper";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type TranscriptProvider = "deepgram" | "assemblyai" | "groq-whisper";

const hasDeepgram = () => !!config.deepgramApiKey;
const hasAssembly = () => !!config.assemblyAiApiKey;
const hasGroq = () => !!(config.grokApiKey || config.grokApiKey2 || config.grokApiKey3);

/** True when at least one free STT path can run soon (not all cooling / empty). */
export const canTranscribeNow = (): boolean => {
  if (hasDeepgram() || hasAssembly()) return true;
  if (!hasGroq()) return false;
  return !isWhisperCircuitOpen() && getWhisperCooldownRemainingMs() < 5_000;
};

export const getTranscribeCooldownRemainingMs = (): number => {
  if (hasDeepgram() || hasAssembly()) return 0;
  return getWhisperCooldownRemainingMs();
};

async function transcribeDeepgram(buf: Buffer): Promise<string> {
  const key = config.deepgramApiKey;
  if (!key) throw new Error("DEEPGRAM_API_KEY missing");
  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || "nova-2",
    smart_format: "true",
    punctuate: "true",
  });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": "audio/mpeg",
    },
    body: new Uint8Array(buf),
  });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Deepgram failed: ${res.status} ${errText.slice(0, 200)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const data = (await res.json()) as {
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
  };
  const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
  return text.trim() || "(no speech detected)";
}

async function assemblyUpload(buf: Buffer): Promise<string> {
  const key = config.assemblyAiApiKey;
  const res = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: {
      authorization: key,
      "content-type": "application/octet-stream",
    },
    body: new Uint8Array(buf),
  });
  if (!res.ok) throw new Error(`AssemblyAI upload failed: ${res.status} ${(await res.text()).slice(0, 160)}`);
  const data = (await res.json()) as { upload_url?: string };
  if (!data.upload_url) throw new Error("AssemblyAI upload missing url");
  return data.upload_url;
}

async function transcribeAssemblyAi(buf: Buffer): Promise<string> {
  const key = config.assemblyAiApiKey;
  if (!key) throw new Error("ASSEMBLYAI_API_KEY missing");
  const uploadUrl = await assemblyUpload(buf);
  const create = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      authorization: key,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      audio_url: uploadUrl,
      speech_model: process.env.ASSEMBLYAI_SPEECH_MODEL || "best",
    }),
  });
  if (!create.ok) {
    throw new Error(`AssemblyAI create failed: ${create.status} ${(await create.text()).slice(0, 160)}`);
  }
  const job = (await create.json()) as { id?: string };
  if (!job.id) throw new Error("AssemblyAI missing transcript id");

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${job.id}`, {
      headers: { authorization: key },
    });
    if (!poll.ok) throw new Error(`AssemblyAI poll failed: ${poll.status}`);
    const data = (await poll.json()) as { status?: string; text?: string; error?: string };
    if (data.status === "completed") return (data.text || "").trim() || "(no speech detected)";
    if (data.status === "error") throw new Error(`AssemblyAI error: ${data.error || "unknown"}`);
  }
  throw new Error("AssemblyAI transcript timed out");
}

/**
 * Download is done by caller (whisper/humanatic). Here we only STT the bytes.
 */
export async function transcribeAudioBuffer(
  buf: Buffer,
): Promise<{ text: string; provider: TranscriptProvider }> {
  const providers: Array<{
    name: TranscriptProvider;
    enabled: boolean;
    run: () => Promise<string>;
  }> = [
    { name: "deepgram", enabled: hasDeepgram(), run: () => transcribeDeepgram(buf) },
    { name: "assemblyai", enabled: hasAssembly(), run: () => transcribeAssemblyAi(buf) },
    {
      name: "groq-whisper",
      enabled: hasGroq() && !isWhisperCircuitOpen(),
      run: () => transcribeWithGroqWhisper(buf),
    },
  ];

  const errors: string[] = [];
  for (const p of providers) {
    if (!p.enabled) continue;
    try {
      console.log(`[stt] Trying ${p.name}…`);
      const text = await p.run();
      console.log(`[stt] ${p.name} ok chars=${text.length}`);
      return { text, provider: p.name };
    } catch (e) {
      const msg = (e as Error).message || String(e);
      console.warn(`[stt] ${p.name} failed: ${msg.slice(0, 180)}`);
      errors.push(`${p.name}: ${msg.slice(0, 100)}`);
    }
  }

  throw new Error(`All STT providers failed (${errors.join(" | ") || "none configured"})`);
}
