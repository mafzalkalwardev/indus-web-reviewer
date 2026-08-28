/**
 * Local control API for dashboard + Tampermonkey + wait worker.
 * Listen: http://127.0.0.1:3847
 */
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { spawn, ChildProcess } from "child_process";
import {
  computeDashboardStats,
  computeDailyReportFor,
  computeDailyReports,
  loadActivityFeed,
  loadDashboardCategories,
  loadReviewLog,
  loadWorkerState,
  patchWorkerStatus,
  patchWorkerTarget,
  saveWorkerState,
} from "../src/storage";
import { findCategoryById } from "../src/categories";
import { getTrafficInsightPayload } from "../src/trafficSchedule";
import { loadGrowthCatalog, growthPaceTip } from "../src/growthCatalog";
import { humanaticLiveForApi } from "../src/humanaticLiveStats";

const PORT = Number(process.env.CONTROL_API_PORT || 3847);
const app = express();

app.use(cors());
app.use(express.json());

/** Serve Tampermonkey userscript as static text */
app.use(
  "/tampermonkey",
  express.static(path.resolve(process.cwd(), "tampermonkey"), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".user.js")) {
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      }
    },
  }),
);

let workerProc: ChildProcess | null = null;

const isWorkerAlive = (): boolean => {
  if (!workerProc || workerProc.killed || workerProc.exitCode != null) return false;
  return true;
};

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/api/worker/target", (_req, res) => {
  res.json(loadWorkerState().target);
});

/** Tampermonkey-friendly alias */
app.get("/api/tm/target", (_req, res) => {
  const target = loadWorkerState().target;
  res.json({
    ...target,
    queueUrl:
      target.categoryId != null
        ? `https://www.humanatic.com/x19/category_selector.cfm?category=${target.categoryId}`
        : null,
  });
});

app.post("/api/worker/target", (req, res) => {
  const body = req.body || {};
  const patch: Record<string, unknown> = {};

  if (body.categoryId !== undefined) {
    const id = body.categoryId === null ? null : Number(body.categoryId);
    patch.categoryId = id;
    if (id != null) {
      const known = findCategoryById(id);
      patch.categoryName = body.categoryName || known?.name || `Category ${id}`;
    } else {
      patch.categoryName = "";
    }
  }
  if (typeof body.categoryName === "string") patch.categoryName = body.categoryName;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.practiceMode === "boolean") patch.practiceMode = body.practiceMode;
  if (typeof body.autoRotate === "boolean") patch.autoRotate = body.autoRotate;
  if (typeof body.paused === "boolean") patch.paused = body.paused;
  if (typeof body.watchBrowser === "boolean") patch.watchBrowser = body.watchBrowser;
  if (body.refreshSeconds !== undefined) {
    const n = Number(body.refreshSeconds);
    patch.refreshSeconds = Number.isFinite(n) ? Math.max(75, Math.min(120, n)) : 75;
  }

  const state = patchWorkerTarget(patch as Parameters<typeof patchWorkerTarget>[0]);
  res.json(state.target);
});

app.get("/api/worker/status", (_req, res) => {
  const state = loadWorkerState();
  res.json({
    ...state.status,
    workerProcessAlive: isWorkerAlive(),
    target: state.target,
  });
});

app.post("/api/worker/start", (_req, res) => {
  const result = startWorkerProcess();
  res.json(result);
});

function startWorkerProcess(): { ok: boolean; message?: string; pid?: number } {
  if (isWorkerAlive()) {
    return { ok: true, message: "Worker already running", pid: workerProc?.pid };
  }

  // Prefer compiled worker (plain node) — ts-node burns 1GB+ RAM.
  const compiledWorker = path.resolve(process.cwd(), "dist", "src", "waitWorker.js");
  const tsNodeBin = path.resolve(process.cwd(), "node_modules", "ts-node", "dist", "bin.js");
  const scriptTs = path.resolve(process.cwd(), "src", "waitWorker.ts");
  const workerArgs = fs.existsSync(compiledWorker)
    ? [compiledWorker]
    : [tsNodeBin, scriptTs];
  workerProc = spawn(process.execPath, workerArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRACTICE_MODE: loadWorkerState().target.practiceMode ? "1" : "0",
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=768"]
        .filter(Boolean)
        .join(" "),
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: false,
  });

  workerProc.stdout?.on("data", (buf) => process.stdout.write(`[worker] ${buf}`));
  workerProc.stderr?.on("data", (buf) => process.stderr.write(`[worker:err] ${buf}`));
  workerProc.on("exit", (code) => {
    console.log(`[api] Wait worker exited code=${code}`);
    workerProc = null;
    const stillWanted = loadWorkerState().target.enabled && !loadWorkerState().target.paused;
    patchWorkerStatus({
      state: stillWanted ? "waiting" : "stopped",
      message: stillWanted
        ? `Worker exited (code ${code}) — auto-restart pending…`
        : `Worker exited (code ${code})`,
      pid: null,
    });
  });

  patchWorkerTarget({ enabled: true });
  patchWorkerStatus({
    state: "waiting",
    message: "Worker starting — launching Chrome profile…",
    pid: workerProc.pid ?? null,
  });

  return { ok: true, pid: workerProc.pid };
}

/** Never-stay-stopped: if target is enabled and worker died, bring it back. */
let lastAutoRestartAt = 0;
setInterval(() => {
  try {
    const { target, status } = loadWorkerState();
    if (!target.enabled || target.paused) return;
    if (isWorkerAlive()) return;
    if (Date.now() - lastAutoRestartAt < 20_000) return;
    // Don't fight an intentional Stop that races the file
    if (status.state === "stopped" && !target.enabled) return;
    lastAutoRestartAt = Date.now();
    console.warn("[api] Watchdog: worker missing while enabled — auto-restart");
    startWorkerProcess();
  } catch (e) {
    console.warn("[api] Watchdog error:", (e as Error).message);
  }
}, 12_000);

app.post("/api/worker/stop", (_req, res) => {
  patchWorkerTarget({ enabled: false });
  if (workerProc && workerProc.pid) {
    const pid = workerProc.pid;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", shell: false });
      } else {
        workerProc.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
    workerProc = null;
  }
  patchWorkerStatus({
    state: "stopped",
    message: "Stopped from dashboard",
    pid: null,
  });
  res.json({ ok: true });
});

app.post("/api/worker/pause", (_req, res) => {
  const state = patchWorkerTarget({ paused: true, enabled: true });
  patchWorkerStatus({
    state: "paused",
    message: "Paused from dashboard — resume when ready",
  });
  res.json({ ok: true, target: state.target });
});

app.post("/api/worker/resume", (_req, res) => {
  const state = patchWorkerTarget({ paused: false, enabled: true });
  patchWorkerStatus({
    state: "waiting",
    message: "Resumed — hunting REVIEW CALLS again",
  });
  res.json({ ok: true, target: state.target });
});

app.post("/api/worker/watch", (req, res) => {
  const enabled = req.body?.enabled !== false && req.body?.enabled !== 0;
  const state = patchWorkerTarget({ watchBrowser: !!enabled });
  patchWorkerStatus({
    message: enabled
      ? "Watch mode ON — Chrome visible, call audio unmuted"
      : "Watch mode OFF — quiet background mode",
  });
  res.json({ ok: true, target: state.target });
});

app.get("/api/categories", (_req, res) => {
  res.json(loadDashboardCategories());
});

app.get("/api/reviews", (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const reviews = loadReviewLog();
  res.json(reviews.slice(-limit).reverse());
});

app.get("/api/stats", (_req, res) => {
  res.json(computeDashboardStats());
});

app.get("/api/reports/daily", (req, res) => {
  const day = String(req.query.day || "").trim();
  if (day && day !== "both") {
    res.json(computeDailyReportFor(day));
    return;
  }
  res.json(computeDailyReports());
});

app.get("/api/activity", (req, res) => {
  const limit = Math.min(400, Math.max(1, Number(req.query.limit) || 80));
  res.json({
    updatedAt: new Date().toISOString(),
    events: loadActivityFeed(limit),
    worker: loadWorkerState().status,
  });
});

app.get("/api/growth", (_req, res) => {
  const today = computeDailyReportFor("today");
  const cats = loadGrowthCatalog().sort((a, b) => (b.payoutCents || 0) - (a.payoutCents || 0));
  const live = humanaticLiveForApi();
  const liveToday = live.todayEarningsCents;
  res.json({
    tip: live.goalTip || growthPaceTip(today.estimatedEarningsCents, today.submitted, 100),
    todayEarningsCents: liveToday != null ? liveToday : today.estimatedEarningsCents,
    todaySubmitted: today.submitted,
    categories: cats.slice(0, 24),
    unlockedWithStock: cats.filter((c) => c.everHadStock).length,
    humanatic: live,
    localEstimateCents: today.estimatedEarningsCents,
  });
});

app.get("/api/humanatic/live", (_req, res) => {
  res.json(humanaticLiveForApi());
});

app.get("/api/traffic", (_req, res) => {
  res.json(getTrafficInsightPayload());
});

app.get("/api/state", (_req, res) => {
  res.json(loadWorkerState());
});

/** Reset status without wiping target */
app.post("/api/worker/status", (req, res) => {
  const state = patchWorkerStatus(req.body || {});
  res.json(state.status);
});

/** Serve built dashboard (Electron + production). API routes stay above. */
const webDist = path.resolve(process.cwd(), "web", "dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/tampermonkey")) {
      return next();
    }
    res.sendFile(path.join(webDist, "index.html"), (err) => {
      if (err) next();
    });
  });
  console.log(`[api] Serving dashboard from ${webDist}`);
}

app.listen(PORT, "127.0.0.1", () => {
  // Ensure state file exists
  saveWorkerState(loadWorkerState());
  const tmPath = path.resolve(process.cwd(), "tampermonkey", "humanatic-category-refresh.user.js");
  console.log(`[api] Control API http://127.0.0.1:${PORT}`);
  console.log(`[api] Tampermonkey script: ${fs.existsSync(tmPath) ? tmPath : "(pending)"}`);
  if (fs.existsSync(webDist)) {
    console.log(`[api] App UI http://127.0.0.1:${PORT}/`);
  }
});
