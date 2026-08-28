/**
 * Launch / attach real Chrome via CDP (shared by engine + wait worker).
 *
 * Chrome 136+: --remote-debugging-port is IGNORED for the standard
 * "Google/Chrome/User Data" folder. We always use a dedicated non-standard
 * user-data-dir (.chrome-cdp-profile) so CDP can bind.
 */
import { chromium, Browser, BrowserContext } from "playwright";
import fs from "fs";
import path from "path";
import { spawn, ChildProcess, execSync } from "child_process";
import { config } from "./config";
import { getAntiDetectionScript } from "./verification";
import { ensureUserscriptManager, getExtensionLaunchArgs, bootstrapUserscripts, prepareExtensionEnvironment } from "./tampermonkeySetup";

const DEBUG_PORT = config.chromeDebugPort;
const CDP_PROFILE_DIR = path.resolve(process.cwd(), ".chrome-cdp-profile");

let chromeProcess: ChildProcess | null = null;

const standardChromeUserDataDir = (): string =>
  path.resolve(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");

const isStandardChromeUserDataDir = (dir: string): boolean => {
  const a = path.resolve(dir).toLowerCase().replace(/\//g, "\\");
  const b = standardChromeUserDataDir().toLowerCase().replace(/\//g, "\\");
  return a === b;
};

export const usingRealChromeProfile = (): boolean => Boolean(config.chromeUserDataDir.trim());

/**
 * Resolve the Chrome user-data-dir used for automation.
 * Never returns the OS default User Data path (CDP blocked since Chrome 136).
 */
export const resolveUserDataDir = (): string => {
  const configured = config.chromeUserDataDir.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (isStandardChromeUserDataDir(resolved)) {
      console.warn(
        "[browser] Chrome 136+ blocks remote debugging on the default User Data folder.",
      );
      console.warn(`[browser] Using dedicated CDP profile instead: ${CDP_PROFILE_DIR}`);
      console.warn(
        "[browser] First run: auto-login from .env (or log in once in this Chrome window).",
      );
      return CDP_PROFILE_DIR;
    }
    return resolved;
  }
  return CDP_PROFILE_DIR;
};

const ensureProfileDir = (userDataDir: string) => {
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
    console.log(`[browser] Created profile directory: ${userDataDir}`);
  }
};

const releaseProfileLock = (userDataDir: string): void => {
  const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"];
  const dirs = [userDataDir, path.join(userDataDir, config.chromeProfileDirectory || "Default")];
  for (const dir of dirs) {
    for (const name of lockFiles) {
      const target = path.join(dir, name);
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch {
        /* ignore */
      }
    }
  }
};

export const findChromeExecutable = (): string | null => {
  const candidates = [
    process.env.CHROME_PATH,
    path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

const waitForDebugger = async (port: number, timeoutMs = 30000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

/** Close only Chrome processes that use our automation user-data-dir. */
const closeChromeUsingUserData = (userDataDir: string): void => {
  try {
    const needle = userDataDir.replace(/\\/g, "\\\\");
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='chrome.exe'\\" -EA 0 | Where-Object { $_.CommandLine -and $_.CommandLine -like '*${needle}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA 0 }"`,
      { timeout: 20000, stdio: "ignore", shell: "cmd.exe" },
    );
  } catch {
    /* ignore */
  }
};

const chromeProcessCountForDir = (userDataDir: string): number => {
  try {
    const needle = userDataDir.replace(/\\/g, "\\\\");
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"name='chrome.exe'\\" -EA 0 | Where-Object { $_.CommandLine -like '*${needle}*' } | Measure-Object).Count"`,
      { timeout: 10000, encoding: "utf8", shell: "cmd.exe" },
    );
    return Number(String(out).trim()) || 0;
  } catch {
    return 0;
  }
};

export const isChromeDebuggerOpen = async (port = DEBUG_PORT): Promise<boolean> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
};

/**
 * Launch Chrome with remote debugging on a non-default user-data-dir, then attach CDP.
 */
export const createCdpContext = async (
  opts: { forceFresh?: boolean } = {},
): Promise<{ browser: Browser; context: BrowserContext }> => {
  const userDataDir = resolveUserDataDir();
  const profileDirectory = config.chromeProfileDirectory || "Default";

  ensureProfileDir(userDataDir);

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error("Google Chrome not found. Install Chrome or set CHROME_PATH.");
  }

  if (opts.forceFresh) {
    console.warn("[browser] Force-fresh Chrome launch requested");
    closeChromeUsingUserData(userDataDir);
    await new Promise((r) => setTimeout(r, 2000));
    releaseProfileLock(userDataDir);
  }

  let alreadyOpen = !opts.forceFresh && (await isChromeDebuggerOpen(DEBUG_PORT));
  let userscriptManager: "tampermonkey" | "violentmonkey" | "none" = "none";

  if (!alreadyOpen) {
    console.log(`[browser] CDP profile: ${userDataDir}`);
    console.log("[browser] Closing any Chrome windows using this automation profile…");
    closeChromeUsingUserData(userDataDir);
    await new Promise((r) => setTimeout(r, 1500));
    for (let i = 0; i < 3 && chromeProcessCountForDir(userDataDir) > 0; i++) {
      closeChromeUsingUserData(userDataDir);
      await new Promise((r) => setTimeout(r, 1500));
    }
    releaseProfileLock(userDataDir);
    alreadyOpen = await isChromeDebuggerOpen(DEBUG_PORT);
  }

  if (!alreadyOpen) {
    console.log(`[browser] Launching Chrome: ${chromePath}`);
    console.log(`[browser] Profile directory: ${profileDirectory}`);
    console.log(`[browser] Debug port: ${DEBUG_PORT}`);

    // Developer mode + VM note so operator-added .user.js in tampermonkey/ inject cleanly
    prepareExtensionEnvironment();

    const packed = await ensureUserscriptManager();
    userscriptManager = packed.manager;
    if (packed.path) {
      console.log(`[browser] Userscript manager: ${packed.manager} @ ${packed.path}`);
    } else {
      console.warn(
        "[browser] No Tampermonkey/Violentmonkey packed — soft-assist will still inject via Playwright",
      );
    }

    const args = [
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDir}`,
      `--profile-directory=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      // Keep RAM flatter on long review sessions
      "--renderer-process-limit=6",
      "--disable-features=Translate,MediaRouter,OptimizationHints",
      "--disable-background-networking",
      `--window-size=${config.browserWidth},${config.browserHeight}`,
      ...(config.backgroundChrome
        ? ["--start-minimized", "--window-position=-32000,-32000"]
        : ["--window-position=20,20"]),
      ...(config.muteCallAudio ? ["--mute-audio"] : []),
      ...getExtensionLaunchArgs(packed.path),
      config.humanaticBaseUrl,
    ];

    console.log(`[browser] Chrome args: ${args.join(" ")}`);

    chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    chromeProcess.unref();

    let ready = await waitForDebugger(DEBUG_PORT, 45000);
    if (!ready) {
      console.warn("[browser] Debug port not up — retrying launch once…");
      closeChromeUsingUserData(userDataDir);
      await new Promise((r) => setTimeout(r, 2500));
      releaseProfileLock(userDataDir);
      chromeProcess = spawn(chromePath, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      chromeProcess.unref();
      ready = await waitForDebugger(DEBUG_PORT, 60000);
    }
    if (!ready) {
      throw new Error(
        `Chrome debug port ${DEBUG_PORT} did not become ready.\n` +
          `Chrome 136+ requires a non-default --user-data-dir (we use ${userDataDir}).\n` +
          `Close Indus Chrome windows, then Start worker again.`,
      );
    }
  } else {
    console.log(`[browser] Attaching to Chrome already listening on port ${DEBUG_PORT}`);
    console.log(`[browser] User data: ${userDataDir} | profile: ${profileDirectory}`);
    const packed = await ensureUserscriptManager().catch(() => ({
      path: null as string | null,
      manager: "none" as const,
    }));
    userscriptManager = packed.manager;
  }

  let browser: Browser;
  try {
    browser = await connectOverCdpSafe(20_000);
  } catch (firstErr) {
    if (opts.forceFresh) throw firstErr;
    console.warn(
      `[browser] CDP connect failed (${(firstErr as Error).message}) — force-fresh relaunch`,
    );
    return createCdpContext({ forceFresh: true });
  }

  const context = browser.contexts()[0] || (await browser.newContext());

  if (!config.skipAntiDetection) {
    await context.addInitScript(getAntiDetectionScript()).catch(() => undefined);
  } else {
    console.log("[browser] Skipping anti-detection injection (profile mode).");
  }

  // Keep Humanatic call audio silent in-page (Whisper still downloads the URL).
  if (config.muteCallAudio) {
    await context
      .addInitScript(() => {
        const silence = (el: HTMLMediaElement) => {
          try {
            el.muted = true;
            el.volume = 0;
          } catch {
            /* ignore */
          }
        };
        const hook = (el: HTMLMediaElement) => {
          silence(el);
          el.addEventListener("play", () => silence(el), true);
          el.addEventListener("volumechange", () => silence(el), true);
        };
        const scan = () => {
          document.querySelectorAll("audio, video").forEach((n) => hook(n as HTMLMediaElement));
        };
        const obs = new MutationObserver(scan);
        const start = () => {
          scan();
          obs.observe(document.documentElement, { childList: true, subtree: true });
        };
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", start, { once: true });
        } else {
          start();
        }
      })
      .catch(() => undefined);
    console.log("[browser] Call audio muted (background / unattended mode)");
  }

  // Auto-inject project .user.js (and try Tampermonkey install UI once)
  await bootstrapUserscripts(context, {
    apiOrigin: `http://127.0.0.1:${process.env.CONTROL_API_PORT || "3847"}`,
    manager: userscriptManager,
  }).catch((e) => {
    console.warn(`[browser] Userscript bootstrap warning: ${(e as Error).message}`);
  });

  return { browser, context };
};

const connectOverCdpSafe = async (timeoutMs = 20_000): Promise<Browser> => {
  return chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`, { timeout: timeoutMs });
};

/**
 * Tear down Playwright CDP + hard-kill automation Chrome, then relaunch.
 * Soft reconnect often hangs on a half-dead debug port — stable-lite always hard resets.
 */
export const recoverCdpContext = async (
  previous?: Browser | null,
): Promise<{ browser: Browser; context: BrowserContext }> => {
  console.warn("[browser] Recovering CDP — hard relaunch Chrome…");
  try {
    if (previous) await previous.close().catch(() => undefined);
  } catch {
    /* ignore */
  }
  return createCdpContext({ forceFresh: true });
};

/** Fallback: Playwright persistent context with Chrome channel. */
export const createPlaywrightContext = async (): Promise<BrowserContext> => {
  const userDataDir = resolveUserDataDir();
  ensureProfileDir(userDataDir);
  releaseProfileLock(userDataDir);

  const launchOptions = {
    headless: false,
    viewport: { width: config.browserWidth, height: config.browserHeight },
    locale: "en-US",
    timezoneId: "America/New_York",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${config.browserWidth},${config.browserHeight}`,
    ],
    ignoreDefaultArgs: ["--enable-automation"] as string[],
  };

  try {
    return await chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      channel: "chrome",
    });
  } catch {
    return await chromium.launchPersistentContext(userDataDir, launchOptions);
  }
};
