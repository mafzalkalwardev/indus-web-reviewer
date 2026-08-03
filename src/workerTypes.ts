/**
 * Shared control-plane types for dashboard / API / wait worker / Tampermonkey.
 */
export type WorkerRunState =
  | "idle"
  | "waiting"
  | "reviewing"
  | "break_room"
  | "error"
  | "stopped";

export type WorkerTarget = {
  categoryId: number | null;
  categoryName: string;
  enabled: boolean;
  practiceMode: boolean;
  /** Tampermonkey poll / refresh cadence (seconds). */
  refreshSeconds: number;
};

export type WorkerStatus = {
  state: WorkerRunState;
  currentUrl: string;
  lastCallAt: string | null;
  message: string;
  updatedAt: string;
  pid: number | null;
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
