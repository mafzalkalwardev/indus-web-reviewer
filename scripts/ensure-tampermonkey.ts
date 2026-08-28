/**
 * Download Tampermonkey (or Violentmonkey fallback) into .chrome-extensions/
 * without launching Chrome. Useful for first-time setup / CI cache.
 *
 *   npm run tm:ensure
 */
import {
  ensureUserscriptManager,
  listUserscriptPaths,
  wrapUserscriptForInjection,
} from "../src/tampermonkeySetup";
import fs from "fs";

async function main() {
  console.log("[tm:ensure] Project userscripts:");
  for (const f of listUserscriptPaths()) {
    console.log(`  - ${f}`);
    const raw = fs.readFileSync(f, "utf8");
    const wrapped = wrapUserscriptForInjection(raw, f.split(/[/\\]/).pop() || "script.user.js");
    if (wrapped.length < 50) throw new Error(`Wrap produced tiny script for ${f}`);
  }

  const result = await ensureUserscriptManager();
  if (!result.path) {
    console.error("[tm:ensure] FAILED — could not download Tampermonkey or Violentmonkey");
    process.exit(1);
  }
  console.log(`[tm:ensure] OK — ${result.manager} at ${result.path}`);
  console.log("[tm:ensure] Soft-assist also injects via Playwright on worker start.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
