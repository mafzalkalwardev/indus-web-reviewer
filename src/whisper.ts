/**
 * Groq Whisper STT + shared audio download.
 * Multi-provider orchestration lives in transcribeProviders.ts (Deepgram → AssemblyAI → Groq).
 */
import fs from "fs";
import path from "path";
import { config } from "./config";
import { currentGrokApiKey, rotateGrokApiKey, grokKeySlotLabel } from "./grokKeys";

/** Per-key cool-down after Whisper 429 (stable-lite: longer to stop storm loops). */
const keyCooldownUntil = new Map<string, number>();
const WHISPER_429_COOLDOWN_MS = Number(process.env.WHISPER_429_COOLDOWN_MS || "180000");

/** Global circuit after consecutive failures — skip Groq Whisper for a while. */
let consecutiveWhisperFails = 0;
let whisperCircuitUntil = 0;
const WHISPER_CIRCUIT_FAILS = Number(process.env.WHISPER_CIRCUIT_FAILS || "3");
const WHISPER_CIRCUIT_MS = Number(process.env.WHISPER_CIRCUIT_MS || "300000");

const allGrokKeys = () =>
  [config.grokApiKey, config.grokApiKey2, config.grokApiKey3].filter(Boolean);

export const getWhisperCooldownRemainingMs = (): number => {
  const cools = allGrokKeys().map((k) => Math.max(0, (keyCooldownUntil.get(k) || 0) - Date.now()));
  const keyCool = cools.length ? Math.max(...cools) : 0;
  return Math.max(keyCool, Math.max(0, whisperCircuitUntil - Date.now()));
};

export const isWhisperCircuitOpen = (): boolean => Date.now() < whisperCircuitUntil;

const noteWhisperFail = () => {
  consecutiveWhisperFails += 1;
  if (consecutiveWhisperFails >= WHISPER_CIRCUIT_FAILS) {
    whisperCircuitUntil = Date.now() + WHISPER_CIRCUIT_MS;
    consecutiveWhisperFails = 0;
    console.warn(
      `[whisper] Circuit OPEN ${Math.round(WHISPER_CIRCUIT_MS / 1000)}s after repeated Groq failures`,
    );
  }
};

const noteWhisperOk = () => {
  consecutiveWhisperFails = 0;
};

const anyKeyReady = (): string | null => {
  const keys = allGrokKeys();
  if (!keys.length) return null;
  for (let i = 0; i < keys.length; i++) {
    const k = currentGrokApiKey();
    if ((keyCooldownUntil.get(k) || 0) <= Date.now()) return k;
    rotateGrokApiKey("whisper-cooldown-skip");
  }
  return null;
};

export async function downloadAudioBuffer(url: string, cookieHeader = ""): Promise<Buffer> {
  if (!url) throw new Error("Empty audio URL");
  const audioRes = await fetch(url, {
    headers: cookieHeader ? { Cookie: cookieHeader, Referer: url } : {},
    redirect: "follow",
  });
  if (!audioRes.ok) throw new Error(`Audio download failed: ${audioRes.status}`);

  const contentType = audioRes.headers.get("content-type") || "";
  if (/text\/html/i.test(contentType)) {
    throw new Error(
      `Audio URL returned HTML (${contentType}) — session cookies missing or expired`,
    );
  }

  const buf = Buffer.from(await audioRes.arrayBuffer());
  if (buf.byteLength < 1024) {
    throw new Error(`Audio download too small (${buf.byteLength} bytes) — not a real recording`);
  }
  return buf;
}

/** Groq Whisper only (rotated across up to 3 keys). */
export async function transcribeWithGroqWhisper(buf: Buffer): Promise<string> {
  if (!allGrokKeys().length) throw new Error("GROK_API_KEY / KEY2 / KEY3 required for Whisper");
  if (isWhisperCircuitOpen()) {
    const left = Math.ceil((whisperCircuitUntil - Date.now()) / 1000);
    throw new Error(`Whisper circuit open ${left}s — resting to protect RAM/CPU & quota`);
  }
  if (!anyKeyReady()) {
    const coolLeft = getWhisperCooldownRemainingMs();
    throw new Error(
      `Whisper cool-down ${Math.ceil(coolLeft / 1000)}s on all Groq keys — try Deepgram/AssemblyAI`,
    );
  }

  const tryWhisper = async (apiKey: string): Promise<string> => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/mpeg" }), "call.mp3");
    form.append("model", process.env.WHISPER_MODEL || "whisper-large-v3");
    form.append("response_format", "json");

    const base = config.grokBaseUrl.replace(/\/$/, "");
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`Whisper failed: ${res.status} ${errText}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    const data = (await res.json()) as { text?: string };
    return (data.text || "").trim() || "(no speech detected)";
  };

  let lastErr: unknown;
  const attempts = Math.max(2, allGrokKeys().length);
  for (let i = 0; i < attempts; i++) {
    const key = currentGrokApiKey();
    try {
      console.log(`[whisper] Groq key ${grokKeySlotLabel()}`);
      const text = await tryWhisper(key);
      noteWhisperOk();
      return text;
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number }).status;
      const msg = (e as Error).message || "";
      if (status === 429 || /429|rate limit/i.test(msg)) {
        keyCooldownUntil.set(key, Date.now() + WHISPER_429_COOLDOWN_MS);
        console.warn(
          `[whisper] 429 on key ${grokKeySlotLabel()} — cool-down ${Math.round(WHISPER_429_COOLDOWN_MS / 1000)}s, rotate`,
        );
        rotateGrokApiKey("whisper-429");
        noteWhisperFail();
        continue;
      }
      noteWhisperFail();
      throw e;
    }
  }
  noteWhisperFail();
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Download call audio then run free STT waterfall (Deepgram → AssemblyAI → Groq).
 */
export const transcribeAudioUrl = async (
  url: string,
  cookieHeader = "",
): Promise<string> => {
  console.log(`[stt] fetch ${url.split("/").pop()}`);
  const buf = await downloadAudioBuffer(url, cookieHeader);

  // Optional local dump for debugging (same as before)
  const tmpDir = path.resolve(process.cwd(), "analysis-output");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `call-audio-${Date.now()}.mp3`);
  try {
    fs.writeFileSync(tmp, buf);
  } catch {
    /* ignore */
  }

  try {
    const { transcribeAudioBuffer } = await import("./transcribeProviders");
    const { text, provider } = await transcribeAudioBuffer(buf);
    console.log(`[stt] done via ${provider} chars=${text.length}`);
    return text;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
};
