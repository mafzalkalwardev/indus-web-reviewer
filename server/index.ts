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
  loadDashboardCategories,
  loadReviewLog,
  loadWorkerState,
  patchWorkerStatus,
  patchWorkerTarget,
  saveWorkerState,
} from "../src/storage";
import { findCategoryById } from "../src/categories";

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
  if (body.refreshSeconds !== undefined) {
    const n = Number(body.refreshSeconds);
    patch.refreshSeconds = Number.isFinite(n) ? Math.max(15, Math.min(120, n)) : 30;
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
  if (isWorkerAlive()) {
    res.json({ ok: true, message: "Worker already running", pid: workerProc?.pid });
    return;
  }

  // Avoid shell + spaces in path (e.g. "Dispatch Softwares") breaking ts-node.
  const tsNodeBin = path.resolve(process.cwd(), "node_modules", "ts-node", "dist", "bin.js");
  const script = path.resolve(process.cwd(), "src", "waitWorker.ts");
  workerProc = spawn(process.execPath, [tsNodeBin, script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRACTICE_MODE: loadWorkerState().target.practiceMode ? "1" : "0",
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
    patchWorkerStatus({
      state: "stopped",
      message: `Worker exited (code ${code})`,
      pid: null,
    });
  });

  patchWorkerTarget({ enabled: true });
  patchWorkerStatus({
    state: "waiting",
    message: "Worker starting — launching Chrome profile…",
    pid: workerProc.pid ?? null,
  });

  res.json({ ok: true, pid: workerProc.pid });
});

app.post("/api/worker/stop", (_req, res) => {
  patchWorkerTarget({ enabled: false });
  if (workerProc && !workerProc.killed) {
    try {
      workerProc.kill("SIGTERM");
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

app.get("/api/state", (_req, res) => {
  res.json(loadWorkerState());
});

/** Reset status without wiping target */
app.post("/api/worker/status", (req, res) => {
  const state = patchWorkerStatus(req.body || {});
  res.json(state.status);
});

app.listen(PORT, "127.0.0.1", () => {
  // Ensure state file exists
  saveWorkerState(loadWorkerState());
  const tmPath = path.resolve(process.cwd(), "tampermonkey", "humanatic-category-refresh.user.js");
  console.log(`[api] Control API http://127.0.0.1:${PORT}`);
  console.log(`[api] Tampermonkey script: ${fs.existsSync(tmPath) ? tmPath : "(pending)"}`);
});
