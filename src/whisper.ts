/**
 * Transcribe call audio via Groq Whisper (OpenAI-compatible /audio/transcriptions).
 */
import fs from "fs";
import path from "path";
import { config } from "./config";

export const transcribeAudioUrl = async (url: string): Promise<string> => {
  if (!config.grokApiKey) throw new Error("GROK_API_KEY required for Whisper");
  if (!url) throw new Error("Empty audio URL");

  console.log(`[whisper] ${url.split("/").pop()}`);
  const audioRes = await fetch(url);
  if (!audioRes.ok) throw new Error(`Audio download failed: ${audioRes.status}`);
  const buf = Buffer.from(await audioRes.arrayBuffer());

  const tmpDir = path.resolve(process.cwd(), "analysis-output");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `call-audio-${Date.now()}.mp3`);
  fs.writeFileSync(tmp, buf);

  try {
    const form = new FormData();
    form.append("file", new Blob([buf], { type: "audio/mpeg" }), path.basename(tmp));
    form.append("model", process.env.WHISPER_MODEL || "whisper-large-v3");
    form.append("response_format", "json");

    const base = config.grokBaseUrl.replace(/\/$/, "");
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.grokApiKey}` },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Whisper failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { text?: string };
    const text = (data.text || "").trim();
    console.log(`[whisper] chars=${text.length}`);
    return text || "(no speech detected)";
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
};
