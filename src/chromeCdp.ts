/**
 * Launch / attach real Chrome via CDP (shared by engine + wait worker).
 */
import { chromium, Browser, BrowserContext } from "playwright";
import fs from "fs";
import path from "path";
import { spawn, ChildProcess, execSync } from "child_process";
import { config } from "./config";
import { getAntiDetectionScript } from "./verification";

const fallbackProfileDir = path.resolve(process.cwd(), config.browserProfilePath);
const DEBUG_PORT = config.chromeDebugPort;

let chromeProcess: ChildProcess | null = null;

export const usingRealChromeProfile = (): boolean => Boolean(config.chromeUserDataDir.trim());

export const resolveUserDataDir = (): string => {
  if (config.chromeUserDataDir.trim()) {
    return path.resolve(config.chromeUserDataDir.trim());
  }
  return fallbackProfileDir;
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

/** Close Chrome instances that hold the target user-data-dir lock. */
const closeChromeUsingUserData = (userDataDir: string): void => {
  try {
    const needle = userDataDir.replace(/\\/g, "\\\\");
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='chrome.exe'\\" -EA 0 | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*${needle}*' -or $_.CommandLine -notmatch 'remote-debugging') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA 0 }"`,
      { timeout: 20000, stdio: "ignore" },
    );
  } catch {
    /* ignore */
  }
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='chrome.exe'\\" -EA 0 | Where-Object { $_.CommandLine -match 'remote-debugging-port=${DEBUG_PORT}|Huamantic Reviewr\\\\.browser-profile' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA 0 }"`,
      { timeout: 15000, stdio: "ignore" },
    );
  } catch {
    /* ignore */
  }
};

/**
 * Chrome single-instance: if ANY chrome.exe is still alive, a new spawn with
 * --remote-debugging-port is ignored and port 9222 never opens. Kill them all.
 */
const killAllChrome = (): void => {
  const attempts = [
    () => execSync("taskkill /F /IM chrome.exe /T", { timeout: 25000, stdio: "pipe", shell: "cmd.exe" }),
    () =>
      execSync(
        `powershell -NoProfile -Command "Get-Process chrome -EA 0 | Stop-Process -Force -EA 0"`,
        { timeout: 25000, stdio: "pipe", shell: "cmd.exe" },
      ),
  ];
  for (const run of attempts) {
    try {
      run();
    } catch {
      /* exit code 128 = nothing to kill */
    }
  }
};

const chromeProcessCount = (): number => {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-Process chrome -EA 0 | Measure-Object).Count"`,
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
 * Launch real Chrome with remote debugging, then attach Playwright via CDP.
 * Prefer CHROME_USER_DATA_DIR + CHROME_PROFILE_DIRECTORY (your real Chrome profile).
 */
export const createCdpContext = async (): Promise<{ browser: Browser; context: BrowserContext }> => {
  const userDataDir = resolveUserDataDir();
  const profileDirectory = config.chromeProfileDirectory || "Default";
  const realProfile = usingRealChromeProfile();

  ensureProfileDir(userDataDir);

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error("Google Chrome not found. Install Chrome or set CHROME_PATH.");
  }

  let alreadyOpen = await isChromeDebuggerOpen(DEBUG_PORT);

  if (!alreadyOpen) {
    if (realProfile) {
      console.log("[browser] Using your real Chrome profile (better Cloudflare trust).");
      console.log("[browser] Closing ALL Chrome windows so remote debugging can bind…");
      closeChromeUsingUserData(userDataDir);
      killAllChrome();
      await new Promise((r) => setTimeout(r, 3500));
      // Retry until Chrome is actually gone (single-instance otherwise eats debug flags)
      for (let i = 0; i < 5 && chromeProcessCount() > 0; i++) {
        console.log(`[browser] Chrome still running (${chromeProcessCount()}) — force kill retry ${i + 1}`);
        killAllChrome();
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (chromeProcessCount() > 0) {
        throw new Error(
          "Could not close Chrome. Close every Chrome window/tray icon manually, then Start worker again.",
        );
      }
      console.log("[browser] Chrome closed — launching with remote debugging…");
    } else {
      closeChromeUsingUserData(userDataDir);
      await new Promise((r) => setTimeout(r, 1500));
    }

    releaseProfileLock(userDataDir);

    // Re-check after kill — leftover debugger from a prior run
    alreadyOpen = await isChromeDebuggerOpen(DEBUG_PORT);
  }

  if (!alreadyOpen) {
    console.log(`[browser] Launching real Chrome: ${chromePath}`);
    console.log(`[browser] User data: ${userDataDir}`);
    if (realProfile) console.log(`[browser] Profile directory: ${profileDirectory}`);
    console.log(`[browser] Debug port: ${DEBUG_PORT}`);

    const args = [
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      `--window-size=${config.browserWidth},${config.browserHeight}`,
      "--window-position=20,20",
      config.humanaticBaseUrl,
    ];

    if (realProfile) {
      args.splice(3, 0, `--profile-directory=${profileDirectory}`);
    }

    console.log(`[browser] Chrome args: ${args.join(" ")}`);

    chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    chromeProcess.unref();

    const ready = await waitForDebugger(DEBUG_PORT, 90000);
    if (!ready) {
      throw new Error(
        `Chrome debug port ${DEBUG_PORT} did not become ready. ` +
          `Close ALL Chrome windows, then re-run. Or start Chrome manually:\n` +
          `"${chromePath}" --remote-debugging-port=${DEBUG_PORT} --remote-allow-origins=* --user-data-dir="${userDataDir}" --profile-directory=${profileDirectory}`,
      );
    }
  } else {
    console.log(`[browser] Attaching to Chrome already listening on port ${DEBUG_PORT}`);
    console.log(`[browser] User data: ${userDataDir} | profile: ${profileDirectory}`);
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const context = browser.contexts()[0] || (await browser.newContext());

  if (!config.skipAntiDetection) {
    await context.addInitScript(getAntiDetectionScript()).catch(() => undefined);
  } else {
    console.log("[browser] Skipping anti-detection injection (real profile mode).");
  }

  return { browser, context };
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
