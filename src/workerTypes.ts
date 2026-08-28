/**
 * Shared control-plane types for dashboard / API / wait worker / Tampermonkey.
 */
export type WorkerRunState =
  | "idle"
  | "waiting"
  | "reviewing"
  | "break_room"
  | "paused"
  | "error"
  | "stopped";

export type WorkerTarget = {
  categoryId: number | null;
  categoryName: string;
  enabled: boolean;
  practiceMode: boolean;
  /** Tampermonkey poll / refresh cadence (seconds). */
  refreshSeconds: number;
  /** Auto-rotate category by EST traffic windows + local empty/hit learning. */
  autoRotate?: boolean;
  /** Soft-pause: worker stays alive but does not hunt/submit until resumed. */
  paused?: boolean;
  /**
   * Watch mode: restore Chrome window + unmute call audio so you can see/hear.
   * When false, Chrome stays quiet/minimized (background earnings mode).
   */
  watchBrowser?: boolean;
};

export type WorkerStatus = {
  state: WorkerRunState;
  currentUrl: string;
  lastCallAt: string | null;
  message: string;
  updatedAt: string;
  pid: number | null;
  /** Latest page-scene intelligence (kind / action / summary). */
  sceneKind?: string;
  sceneAction?: string;
  sceneSummary?: string;
};

export type WorkerStateFile = {
  target: WorkerTarget;
  status: WorkerStatus;
};

export const defaultWorkerState = (): WorkerStateFile => ({
  target: {
    categoryId: 3,
    categoryName: "Inbound",
    enabled: false,
    practiceMode: true,
    refreshSeconds: 30,
    autoRotate: true,
    paused: false,
    watchBrowser: false,
  },
  status: {
    state: "stopped",
    currentUrl: "",
    lastCallAt: null,
    message: "Worker not started",
    updatedAt: new Date().toISOString(),
    pid: null,
  },
});
