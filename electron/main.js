/**
 * Indus Web Reviewer — Electron shell
 * Starts Control API, then opens the dashboard in a native window.
 */
const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const API_PORT = Number(process.env.CONTROL_API_PORT || 3847);
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

let mainWindow = null;
let apiProc = null;
let stopping = false;

const isDev = () => process.env.ELECTRON_DEV === "1" || process.env.ELECTRON_DEV === "true";

function apiHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${API_ORIGIN}/api/health`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForApi(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await apiHealth()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function resolveNodeBinary() {
  if (process.env.npm_node_execpath && fs.existsSync(process.env.npm_node_execpath)) {
    return process.env.npm_node_execpath;
  }
  // Under Electron, process.execPath is Electron — never use it to run ts-node.
  if (process.versions.electron) {
    return process.platform === "win32" ? "node.exe" : "node";
  }
  return process.execPath;
}

function resolveApiEntry() {
  const compiled = path.join(ROOT, "dist", "server", "index.js");
  const tsNodeBin = path.join(ROOT, "node_modules", "ts-node", "dist", "bin.js");
  const serverTs = path.join(ROOT, "server", "index.ts");
  if (fs.existsSync(compiled)) {
    return { args: [compiled], mode: "compiled" };
  }
  // Dev fallback only — compiled node uses far less RAM
  return { args: [tsNodeBin, serverTs], mode: "ts-node" };
}

function startApiIfNeeded() {
  return apiHealth().then(async (ok) => {
    if (ok) {
      console.log("[electron] Control API already running");
      return;
    }

    const nodeBin = resolveNodeBinary();
    const entry = resolveApiEntry();
    console.log(`[electron] Starting Control API (${entry.mode}) with ${nodeBin}…`);

    apiProc = spawn(nodeBin, entry.args, {
      cwd: ROOT,
      env: {
        ...process.env,
        CONTROL_API_PORT: String(API_PORT),
        ELECTRON_RUN: "1",
        // Cap heap so a stuck dashboard refresh cannot devour the machine
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=768"]
          .filter(Boolean)
          .join(" "),
      },
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    });

    apiProc.on("exit", (code) => {
      apiProc = null;
      if (!stopping) {
        console.error(`[electron] Control API exited (code ${code})`);
      }
    });
  });
}

function stopApi() {
  if (!apiProc || !apiProc.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(apiProc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      apiProc.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
  apiProc = null;
}

async function createWindow() {
  const iconPath = path.join(ROOT, "brand", "indus-web-reviewer-logo.png");

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "Indus Web Reviewer",
    backgroundColor: "#eef3f7",
    autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev()) {
    await mainWindow.loadURL("http://127.0.0.1:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadURL(`${API_ORIGIN}/`);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    await startApiIfNeeded();
    const ready = await waitForApi();
    if (!ready) {
      console.error("[electron] Control API did not become ready on", API_ORIGIN);
    }
    await createWindow();
  } catch (err) {
    console.error("[electron] Startup failed:", err);
    app.quit();
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopping = true;
  stopApi();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopping = true;
  stopApi();
});
