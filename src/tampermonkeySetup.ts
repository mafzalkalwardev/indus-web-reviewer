/**
 * Auto-provision Tampermonkey (or Violentmonkey fallback) into the CDP Chrome
 * profile, install project .user.js scripts, and inject them via Playwright so
 * soft-assist always runs even if the extension UI is delayed.
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { BrowserContext, Page } from "playwright";

const EXT_ROOT = path.resolve(process.cwd(), ".chrome-extensions");
const TM_DIR = path.join(EXT_ROOT, "tampermonkey");
const VM_DIR = path.join(EXT_ROOT, "violentmonkey");
const STATE_FILE = path.join(EXT_ROOT, "installed-scripts.json");
const USERSCRIPT_DIR = path.resolve(process.cwd(), "tampermonkey");

/** Chrome Web Store id for Tampermonkey. */
const TAMPERMONKEY_ID = "dhdgffkkebhmkfjojejmpbldmpobfkfo";

type InstalledState = {
  manager: "tampermonkey" | "violentmonkey" | "none";
  scripts: string[];
  installedAt: string;
};

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const readState = (): InstalledState => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as InstalledState;
  } catch {
    return { manager: "none", scripts: [], installedAt: "" };
  }
};

const writeState = (state: InstalledState) => {
  ensureDir(EXT_ROOT);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
};

/** List project userscripts (*.user.js). */
export const listUserscriptPaths = (): string[] => {
  if (!fs.existsSync(USERSCRIPT_DIR)) return [];
  return fs
    .readdirSync(USERSCRIPT_DIR)
    .filter((f) => f.endsWith(".user.js"))
    .map((f) => path.join(USERSCRIPT_DIR, f))
    .sort();
};

/**
 * Strip ==UserScript== header and wrap with @match URL gating + one-shot guard
 * so Playwright init injection is safe on every page.
 */
export const wrapUserscriptForInjection = (source: string, fileName: string): string => {
  const matchPatterns = Array.from(source.matchAll(/@match\s+(\S+)/g)).map((m) => m[1]);
  const body = source
    .replace(/\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==\s*/m, "")
    .trim();

  const regexSources = (matchPatterns.length ? matchPatterns : ["*://*/*"]).map((p) => {
    if (p === "*://*/*") return "^https?:\\/\\/.*$";
    let out = "^";
    for (const ch of p) {
      if (ch === "*") out += ".*";
      else if ("\\.^$+?()[]{}|".includes(ch)) out += "\\" + ch;
      else out += ch;
    }
    out += "$";
    return out;
  });

  const key = JSON.stringify(`iwr_tm_${fileName}`);
  const regsJson = JSON.stringify(regexSources);

  return `(() => {
  try {
    const key = ${key};
    if (window[key]) return;
    window[key] = true;
    const href = String(location.href || "");
    const regs = ${regsJson}.map((s) => new RegExp(s, "i"));
    if (!regs.some((re) => re.test(href))) return;
    ${body}
  } catch (e) {
    console.warn("[IWR] userscript inject failed", e);
  }
})();`;
};

/** Unpack a Chrome CRX3 buffer into destDir (writes zip then Expand-Archive). */
const unpackCrx3 = (buf: Buffer, destDir: string): void => {
  ensureDir(destDir);
  let zipBuf = buf;
  if (buf.toString("utf8", 0, 4) === "Cr24") {
    const headerSize = buf.readUInt32LE(8);
    zipBuf = buf.subarray(12 + headerSize);
  } else if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new Error("Downloaded file is not a CRX/ZIP extension package");
  }

  const zipPath = path.join(EXT_ROOT, `_tmp_ext_${Date.now()}.zip`);
  fs.writeFileSync(zipPath, zipBuf);
  try {
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    ensureDir(destDir);
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force"`,
      { stdio: "ignore", timeout: 120000 },
    );
  } finally {
    try {
      fs.unlinkSync(zipPath);
    } catch {
      /* ignore */
    }
  }
};

const hasManifest = (dir: string): boolean =>
  fs.existsSync(path.join(dir, "manifest.json"));

/** Download Tampermonkey from the Chrome update service and unpack. */
const downloadTampermonkey = async (): Promise<string> => {
  ensureDir(EXT_ROOT);
  const url =
    `https://clients2.google.com/service/update2/crx?response=redirect` +
    `&prodversion=131.0.0.0&acceptformat=crx2,crx3` +
    `&x=id%3D${TAMPERMONKEY_ID}%3Binstallsource%3Dondemand%3Buc`;

  console.log("[tm] Downloading Tampermonkey…");
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Tampermonkey download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 10_000) throw new Error("Tampermonkey download too small");
  unpackCrx3(buf, TM_DIR);
  if (!hasManifest(TM_DIR)) throw new Error("Tampermonkey unpack missing manifest.json");
  console.log(`[tm] Tampermonkey ready at ${TM_DIR}`);
  return TM_DIR;
};

/** Download Violentmonkey (open-source) as fallback userscript manager. */
const downloadViolentmonkey = async (): Promise<string> => {
  ensureDir(EXT_ROOT);
  // Pin a known release; update as needed
  const url =
    "https://github.com/violentmonkey/violentmonkey/releases/download/v2.31.0/violentmonkey-webext-v2.31.0.zip";
  console.log("[tm] Downloading Violentmonkey (Tampermonkey fallback)…");
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "IndusWebReviewer" },
  });
  if (!res.ok) throw new Error(`Violentmonkey download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zipPath = path.join(EXT_ROOT, `_vm_${Date.now()}.zip`);
  fs.writeFileSync(zipPath, buf);
  try {
    if (fs.existsSync(VM_DIR)) fs.rmSync(VM_DIR, { recursive: true, force: true });
    ensureDir(VM_DIR);
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${VM_DIR.replace(/'/g, "''")}' -Force"`,
      { stdio: "ignore", timeout: 120000 },
    );
    // Some zips nest a single folder
    if (!hasManifest(VM_DIR)) {
      const kids = fs.readdirSync(VM_DIR).map((k) => path.join(VM_DIR, k));
      const nested = kids.find((k) => fs.statSync(k).isDirectory() && hasManifest(k));
      if (nested) {
        for (const f of fs.readdirSync(nested)) {
          fs.renameSync(path.join(nested, f), path.join(VM_DIR, f));
        }
      }
    }
  } finally {
    try {
      fs.unlinkSync(zipPath);
    } catch {
      /* ignore */
    }
  }
  if (!hasManifest(VM_DIR)) throw new Error("Violentmonkey unpack missing manifest.json");
  console.log(`[tm] Violentmonkey ready at ${VM_DIR}`);
  return VM_DIR;
};

/**
 * Ensure a userscript manager extension is on disk.
 * Violentmonkey first (reliable zip). Tampermonkey CRX attempted as preferred
 * brand when Google still serves the store package.
 */
export const ensureUserscriptManager = async (): Promise<{
  path: string | null;
  manager: "tampermonkey" | "violentmonkey" | "none";
}> => {
  if (hasManifest(TM_DIR)) {
    return { path: TM_DIR, manager: "tampermonkey" };
  }
  if (hasManifest(VM_DIR)) {
    return { path: VM_DIR, manager: "violentmonkey" };
  }

  // Prefer Violentmonkey: store CRX endpoint often 404s; GitHub zip is stable.
  try {
    const p = await downloadViolentmonkey();
    return { path: p, manager: "violentmonkey" };
  } catch (e) {
    console.warn(`[tm] Violentmonkey download failed: ${(e as Error).message}`);
  }

  try {
    const p = await downloadTampermonkey();
    return { path: p, manager: "tampermonkey" };
  } catch (e) {
    console.warn(`[tm] Tampermonkey download failed: ${(e as Error).message}`);
  }

  return { path: null, manager: "none" };
};

/** Chrome launch flags to load the unpacked userscript manager. */
export const getExtensionLaunchArgs = (extensionPath: string | null): string[] => {
  if (!extensionPath) return [];
  // Allow the extension + keep any others already in the profile
  return [
    `--load-extension=${extensionPath}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
  ];
};

/** Inject all project userscripts into the Playwright context (new pages + existing). */
export const injectProjectUserscripts = async (context: BrowserContext): Promise<number> => {
  const files = listUserscriptPaths();
  if (!files.length) {
    console.warn("[tm] No *.user.js files in tampermonkey/");
    return 0;
  }

  let n = 0;
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const wrapped = wrapUserscriptForInjection(raw, path.basename(file));
    await context.addInitScript(wrapped).catch((e) => {
      console.warn(`[tm] addInitScript failed for ${path.basename(file)}:`, (e as Error).message);
    });

    for (const page of context.pages()) {
      await page.evaluate(wrapped).catch(() => undefined);
    }
    console.log(`[tm] Injected userscript: ${path.basename(file)}`);
    n += 1;
  }
  return n;
};

/**
 * Open each .user.js via the local Control API so Tampermonkey/Violentmonkey
 * can one-click install it into the extension storage.
 */
export const installUserscriptsViaManager = async (
  page: Page,
  apiOrigin = "http://127.0.0.1:3847",
): Promise<void> => {
  const files = listUserscriptPaths();
  if (!files.length) return;

  const state = readState();
  const pending = files.filter((f) => !state.scripts.includes(path.basename(f)));
  if (!pending.length) {
    console.log("[tm] Userscripts already marked installed in extension state");
    return;
  }

  for (const file of pending) {
    const name = path.basename(file);
    const url = `${apiOrigin}/tampermonkey/${encodeURIComponent(name)}`;
    console.log(`[tm] Opening install page for ${name}`);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await new Promise((r) => setTimeout(r, 1500));

      // Tampermonkey / Violentmonkey install buttons
      const installBtn = page
        .locator(
          [
            'button:has-text("Install")',
            'input[type="button"][value="Install"]',
            'a:has-text("Install")',
            ".install-button",
            "#btnInstall",
          ].join(", "),
        )
        .first();

      if (await installBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
        await installBtn.click({ timeout: 5000 }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 1200));
        console.log(`[tm] Clicked Install for ${name}`);
      } else {
        // Raw .user.js served as text — manager may not intercept localhost.
        // Playwright injection (injectProjectUserscripts) covers this case.
        console.warn(
          `[tm] No Install UI for ${name} — relying on Playwright injection (soft-assist still active)`,
        );
      }
    } catch (e) {
      console.warn(`[tm] Install navigation failed for ${name}: ${(e as Error).message}`);
    }
  }

  writeState({
    manager: state.manager === "none" ? "tampermonkey" : state.manager,
    scripts: files.map((f) => path.basename(f)),
    installedAt: new Date().toISOString(),
  });
};

/**
 * Flip Chrome developer_mode in the CDP profile so Violentmonkey / userscripts can run.
 * Does not invent face-bypass logic — only pref + note for operator-added scripts.
 */
export const prepareExtensionEnvironment = (): void => {
  const prefsPath = path.resolve(process.cwd(), ".chrome-cdp-profile", "Default", "Preferences");
  try {
    if (fs.existsSync(prefsPath)) {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8")) as Record<string, unknown>;
      const extensions = (prefs.extensions as Record<string, unknown>) || {};
      const ui = (extensions.ui as Record<string, unknown>) || {};
      ui.developer_mode = true;
      extensions.ui = ui;
      prefs.extensions = extensions;
      fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 3), "utf8");
      console.log("[ext] Chrome developer_mode=true in CDP profile Preferences");
    } else {
      console.warn(`[ext] Preferences not found yet (will exist after first Chrome launch): ${prefsPath}`);
    }
  } catch (e) {
    console.warn(`[ext] Could not set developer_mode: ${(e as Error).message}`);
  }

  if (hasManifest(VM_DIR) || hasManifest(TM_DIR)) {
    const note = path.join(EXT_ROOT, "IWR-ALLOW-USERSCRIPTS.txt");
    fs.writeFileSync(
      note,
      [
        "Drop your *.user.js files into the project tampermonkey/ folder.",
        "They are auto-injected on every Chrome/worker start.",
        "Chrome developer mode is enabled in .chrome-cdp-profile Preferences.",
        "Face scripts: you add them yourself — the worker only waits for face_verify.cfm to clear.",
        "",
      ].join("\n"),
      "utf8",
    );
  }
};

/**
 * Full bootstrap after CDP attach: inject scripts always; try extension install UI once.
 */
export const bootstrapUserscripts = async (
  context: BrowserContext,
  opts: { apiOrigin?: string; manager?: "tampermonkey" | "violentmonkey" | "none" } = {},
): Promise<void> => {
  const injected = await injectProjectUserscripts(context);
  console.log(`[tm] Playwright-injected ${injected} userscript(s)`);

  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  try {
    await installUserscriptsViaManager(page, opts.apiOrigin || "http://127.0.0.1:3847");
  } catch (e) {
    console.warn(`[tm] Extension install step skipped: ${(e as Error).message}`);
  }

  const state = readState();
  if (opts.manager && opts.manager !== "none") {
    writeState({ ...state, manager: opts.manager, installedAt: state.installedAt || new Date().toISOString() });
  }
};
