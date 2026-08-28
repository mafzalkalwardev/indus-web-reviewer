import { useCallback, useEffect, useState } from "react";
import {
  api,
  ActivityEvent,
  Category,
  DailyReport,
  HumanaticLive,
  Review,
  Stats,
  TrafficInsight,
  WorkerStatus,
  WorkerTarget,
} from "./api";

function ReportCard({ report }: { report: DailyReport }) {
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <strong>
          {report.label}{" "}
          <span className="mono muted">({report.day})</span>
        </strong>
        <span className="mono">{report.estimatedEarningsLabel}</span>
      </div>
      <div className="grid grid-4" style={{ marginBottom: 10 }}>
        <div className="panel stat" style={{ margin: 0, padding: 10 }}>
          <div className="label">Submitted</div>
          <div className="value" style={{ fontSize: 22 }}>
            {report.submitted}
          </div>
        </div>
        <div className="panel stat" style={{ margin: 0, padding: 10 }}>
          <div className="label">Skipped</div>
          <div className="value" style={{ fontSize: 22 }}>
            {report.skipped}
          </div>
        </div>
        <div className="panel stat" style={{ margin: 0, padding: 10 }}>
          <div className="label">Avg conf</div>
          <div className="value" style={{ fontSize: 22 }}>
            {report.avgConfidence ? report.avgConfidence.toFixed(2) : "—"}
          </div>
        </div>
        <div className="panel stat" style={{ margin: 0, padding: 10 }}>
          <div className="label">Span (h)</div>
          <div className="value" style={{ fontSize: 22 }}>
            {report.activeSpanHours || "—"}
          </div>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        No transcript: {report.skippedNoTranscript} · Low conf: {report.skippedLowConfidence} ·
        Heuristic blocked: {report.skippedHeuristic} · Other skip: {report.skippedError} · Practice:{" "}
        {report.practiceSelected}
      </div>
      {report.topSkipReasons.length ? (
        <div className="table-wrap" style={{ maxHeight: 140 }}>
          <table>
            <thead>
              <tr>
                <th>Top skip reasons</th>
                <th>n</th>
              </tr>
            </thead>
            <tbody>
              {report.topSkipReasons.slice(0, 5).map((r) => (
                <tr key={r.reason}>
                  <td className="muted">{r.reason}</td>
                  <td className="mono">{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [traffic, setTraffic] = useState<TrafficInsight | null>(null);
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [target, setTarget] = useState<WorkerTarget | null>(null);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [daily, setDaily] = useState<{ today: DailyReport; yesterday: DailyReport } | null>(null);
  const [reportTab, setReportTab] = useState<"today" | "yesterday">("today");
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [growthTip, setGrowthTip] = useState("");
  const [humanatic, setHumanatic] = useState<HumanaticLive | null>(null);
  const [localEstLabel, setLocalEstLabel] = useState("");

  const [failStreak, setFailStreak] = useState(0);
  const [apiSoftNote, setApiSoftNote] = useState("");

  const refreshLight = useCallback(async () => {
    try {
      const [stat, tgt] = await Promise.all([api.status(), api.target()]);
      setStatus(stat);
      setTarget(tgt);
      setFailStreak(0);
      setApiSoftNote("");
      setError("");
      return true;
    } catch (e) {
      const msg = (e as Error).message || "Dashboard reconnecting…";
      setFailStreak((n) => {
        const next = n + 1;
        // Soft note for 1–2 misses; hard banner only after sustained outage
        if (next >= 4) setError(msg);
        else setApiSoftNote(msg);
        return next;
      });
      return false;
    }
  }, []);

  const refreshHeavy = useCallback(async () => {
    try {
      const [cats, revs, st, traf, days, act, growth] = await Promise.all([
        api.categories(),
        api.reviews(30),
        api.stats(),
        api.traffic(),
        api.dailyReports(),
        api.activity(30),
        api.growth().catch(() => null),
      ]);
      setCategories(cats);
      setReviews(revs);
      setStats(st);
      setTraffic(traf);
      setDaily(days);
      setActivity(act.events || []);
      if (growth?.tip) setGrowthTip(growth.tip);
      if (growth?.humanatic) setHumanatic(growth.humanatic);
      if (growth?.localEstimateCents != null) {
        const c = growth.localEstimateCents;
        setLocalEstLabel(c >= 100 ? `$${(c / 100).toFixed(2)}` : `${Number(c.toFixed(2))}¢`);
      }
    } catch {
      // Heavy endpoints optional — never wipe status UI for these
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let heavyTick = 0;
    const tick = async () => {
      if (cancelled) return;
      const ok = await refreshLight();
      heavyTick += 1;
      // Heavy bundle every ~4 light ticks (~20s) and only when API is healthy
      if (ok && heavyTick % 4 === 1) await refreshHeavy();
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshLight, refreshHeavy]);

  const refresh = refreshLight;

  const workCategory = async (id: number, name: string) => {
    setBusy(true);
    try {
      const next = await api.setTarget({
        categoryId: id,
        categoryName: name,
        enabled: true,
      });
      setTarget(next);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const patchTarget = async (patch: Partial<WorkerTarget>) => {
    setBusy(true);
    try {
      const next = await api.setTarget(patch);
      setTarget(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    try {
      await api.setTarget({ enabled: true });
      await api.start();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await api.stop();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pause = async () => {
    setBusy(true);
    try {
      await api.pause();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    try {
      await api.resume();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleWatch = async (on: boolean) => {
    setBusy(true);
    try {
      await api.watch(on);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stateClass = (status?.state || "stopped").replace(/\s+/g, "_");

  return (
    <div className="app">
      <header className="top">
        <div className="brand-block">
          <img className="logo" src="/logo.png" alt="Indus Web Reviewer" width={48} height={48} />
          <div>
            <div className="brand">
              Indus Web <span>Reviewer</span>
            </div>
            <div className="sub">Pick a category — Tampermonkey refreshes — AI waits for the call screen</div>
          </div>
        </div>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <span className={`badge ${stateClass}`}>{status?.state || "…"}</span>
          <button className="btn btn-primary" disabled={busy} onClick={start}>
            Start worker
          </button>
          {status?.state === "paused" || target?.paused ? (
            <button className="btn btn-primary" disabled={busy} onClick={resume}>
              Resume
            </button>
          ) : (
            <button className="btn" disabled={busy || !status?.workerProcessAlive} onClick={pause}>
              Pause
            </button>
          )}
          <button
            className={`btn ${target?.watchBrowser ? "btn-primary" : ""}`}
            disabled={busy || !status?.workerProcessAlive}
            onClick={() => toggleWatch(!target?.watchBrowser)}
            title="Show Chrome and unmute call audio so you can watch and listen"
          >
            {target?.watchBrowser ? "Watching (hear on)" : "Watch & listen"}
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={stop}>
            Stop
          </button>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}
      {!error && apiSoftNote ? (
        <div className="error-banner" style={{ background: "#fff7e6", color: "#8a5a00", borderColor: "#f0d9a0" }}>
          {apiSoftNote}
        </div>
      ) : null}
      {humanatic ? (
        <section className="panel humanatic-mirror" style={{ marginBottom: 16 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <h2 style={{ margin: 0 }}>Humanatic earnings</h2>
            <span className="muted mono" style={{ fontSize: 12 }}>
              {humanatic.scrapedAt
                ? `Synced ${new Date(humanatic.scrapedAt).toLocaleTimeString()}`
                : "Waiting for scrape…"}
              {humanatic.profileName ? ` · ${humanatic.profileName}` : ""}
            </span>
          </div>
          <div className="grid grid-4" style={{ marginTop: 12, marginBottom: 12 }}>
            <div className="panel stat" style={{ margin: 0 }}>
              <div className="label">Today (site)</div>
              <div className="value">{humanatic.todayEarningsLabel || "—"}</div>
            </div>
            <div className="panel stat" style={{ margin: 0 }}>
              <div className="label">Balance</div>
              <div className="value">{humanatic.balanceLabel || "—"}</div>
            </div>
            <div className="panel stat" style={{ margin: 0 }}>
              <div className="label">Accuracy</div>
              <div className="value">{humanatic.accuracyOverallLabel || "—"}</div>
            </div>
            <div className="panel stat" style={{ margin: 0 }}>
              <div className="label">Leaderboard</div>
              <div className="value">
                {humanatic.yourRank != null ? `#${humanatic.yourRank}` : "—"}
              </div>
            </div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
              <span className="label">${humanatic.goalDollars}/mo goal</span>
              <span className="mono">{humanatic.goalProgressPct}%</span>
            </div>
            <div className="goal-track">
              <div className="goal-fill" style={{ width: `${Math.min(100, humanatic.goalProgressPct)}%` }} />
            </div>
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              {humanatic.goalTip}
            </div>
            {humanatic.periodLabel ? (
              <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                {humanatic.periodLabel}
              </div>
            ) : null}
          </div>
          {humanatic.leaderboard.length > 0 ? (
            <details style={{ marginTop: 12 }}>
              <summary className="label" style={{ cursor: "pointer" }}>
                Leaderboard (synced rarely — expand if curious)
                {humanatic.yourRank != null ? ` · you #${humanatic.yourRank}` : ""}
              </summary>
              <div className="lb-table mono" style={{ marginTop: 8 }}>
                {humanatic.leaderboard.slice(0, 12).map((row) => (
                  <div key={`${row.rank}-${row.name}`} className={`lb-row${row.isYou ? " you" : ""}`}>
                    <span className="lb-rank">#{row.rank}</span>
                    <span className="lb-name">{row.name}{row.isYou ? " · you" : ""}</span>
                    <span className="lb-score">{row.scoreLabel}</span>
                  </div>
                ))}
              </div>
            </details>
          ) : (
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Stats sync every ~4h or each +$1 earned — worker stays on calls.
            </div>
          )}
          {humanatic.categoryAccuracy.length > 0 ? (
            <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              Category accuracy:{" "}
              {humanatic.categoryAccuracy
                .slice(0, 6)
                .map((c) => `${c.name} ${c.accuracyPct != null ? `${c.accuracyPct}%` : "—"}`)
                .join(" · ")}
            </div>
          ) : null}
        </section>
      ) : growthTip ? (
        <div className="panel" style={{ marginBottom: 12, padding: "10px 14px", fontSize: 13 }}>
          <span className="label">GROWTH · $100/mo pace</span>
          <div style={{ marginTop: 4 }}>{growthTip}</div>
          <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
            Accuracy-first mode: skip unsure calls · prefer high-¢ categories where your site accuracy is healthy.
          </div>
        </div>
      ) : null}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="panel stat">
          <div className="label">Today (site)</div>
          <div className="value">
            {humanatic?.todayEarningsLabel ?? stats?.estimatedEarningsLabel ?? "—"}
          </div>
          {localEstLabel ? (
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Local log est. {localEstLabel}
            </div>
          ) : null}
        </div>
        <div className="panel stat">
          <div className="label">Submitted</div>
          <div className="value">{stats?.submitted ?? "—"}</div>
        </div>
        <div className="panel stat">
          <div className="label">Site accuracy</div>
          <div className="value">
            {humanatic?.accuracyOverallLabel ??
              (stats ? `${Math.round(stats.accuracyProxy * 100)}%` : "—")}
          </div>
        </div>
        <div className="panel stat">
          <div className="label">LB rank</div>
          <div className="value">
            {humanatic?.yourRank != null ? `#${humanatic.yourRank}` : "—"}
          </div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <section className="panel">
          <h2>Control</h2>
          <div className="row">
            <div className="field">
              <label>Active category</label>
              <select
                value={target?.categoryId ?? ""}
                disabled={busy}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  const cat = categories.find((c) => c.id === id);
                  if (cat) workCategory(cat.id, cat.name);
                }}
              >
                <option value="" disabled>
                  Select…
                </option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.id} {c.name}
                    {c.payoutLabel ? ` (${c.payoutLabel})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ maxWidth: 140 }}>
              <label>TM refresh (sec)</label>
              <input
                type="number"
                min={75}
                max={120}
                value={Math.max(75, target?.refreshSeconds ?? 75)}
                disabled={busy}
                onChange={(e) => patchTarget({ refreshSeconds: Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="row" style={{ marginTop: 14 }}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={!!target?.enabled}
                disabled={busy}
                onChange={(e) => patchTarget({ enabled: e.target.checked })}
              />
              Target enabled (TM + worker)
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={!!target?.practiceMode}
                disabled={busy}
                onChange={(e) => patchTarget({ practiceMode: e.target.checked })}
              />
              Practice mode (no live submit)
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={target?.autoRotate !== false}
                disabled={busy}
                onChange={(e) => patchTarget({ autoRotate: e.target.checked })}
              />
              Auto-rotate by traffic (ET)
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={!!target?.watchBrowser}
                disabled={busy}
                onChange={(e) => toggleWatch(e.target.checked)}
              />
              Watch &amp; listen (show Chrome + unmute)
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={!!target?.paused}
                disabled={busy}
                onChange={(e) => (e.target.checked ? pause() : resume())}
              />
              Paused
            </label>
          </div>

          <div className="msg">
            {status?.message || "—"}
            {status?.sceneKind ? (
              <>
                <br />
                Scene:{" "}
                <span className="mono">
                  {status.sceneKind} → {status.sceneAction || "?"}
                  {status.sceneSummary ? ` · ${status.sceneSummary}` : ""}
                </span>
              </>
            ) : null}
            {status?.currentUrl ? (
              <>
                <br />
                <span className="mono">{status.currentUrl}</span>
              </>
            ) : null}
            {status?.lastCallAt ? (
              <>
                <br />
                Last call: <span className="mono">{status.lastCallAt}</span>
              </>
            ) : null}
            <br />
            Worker process:{" "}
            <span className="mono">
              {status?.workerProcessAlive ? `alive pid=${status.pid}` : "not running"}
            </span>
          </div>

          <div className="note">
            Install Tampermonkey script once (Default Chrome profile): open{" "}
            <a href="/tampermonkey/humanatic-category-refresh.user.js" target="_blank" rel="noreferrer">
              humanatic-category-refresh.user.js
            </a>{" "}
            then click Install. Start worker launches your Chrome profile with CDP debugging.
          </div>
        </section>

        <section className="panel">
          <h2>Traffic (US Eastern)</h2>
          {traffic ? (
            <>
              <div className="msg" style={{ marginTop: 0 }}>
                <strong>{traffic.clock.label}</strong> · window{" "}
                <span className="mono">{traffic.window}</span>
                {traffic.peak ? " · peak volume" : " · off-peak"}
                {traffic.primeBonus ? " · prime bonus band" : ""}
                <br />
                {traffic.tip}
                <br />
                <span className="muted">
                  Research: peak {traffic.research.peakHoursEt}; {traffic.research.primeBonusEt}
                </span>
              </div>
              <div className="table-wrap" style={{ maxHeight: 180, marginTop: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Try</th>
                      <th>Category</th>
                      <th>Score</th>
                      <th>Local</th>
                    </tr>
                  </thead>
                  <tbody>
                    {traffic.ranked.slice(0, 6).map((r, i) => (
                      <tr
                        key={r.categoryId}
                        className={target?.categoryId === r.categoryId ? "active" : undefined}
                      >
                        <td className="mono">{i + 1}</td>
                        <td>
                          #{r.categoryId} {r.name}
                          {r.payoutCents ? (
                            <span className="muted"> · {r.payoutCents}¢</span>
                          ) : null}
                        </td>
                        <td className="mono">{r.score}</td>
                        <td className="muted">{r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="muted">Loading traffic insight…</div>
          )}
        </section>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <section className="panel">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0 }}>Daily report</h2>
            <div className="row" style={{ gap: 8 }}>
              <button
                className={`btn ${reportTab === "today" ? "btn-primary" : ""}`}
                type="button"
                onClick={() => setReportTab("today")}
              >
                Today
              </button>
              <button
                className={`btn ${reportTab === "yesterday" ? "btn-primary" : ""}`}
                type="button"
                onClick={() => setReportTab("yesterday")}
              >
                Yesterday
              </button>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            {daily ? (
              <ReportCard report={reportTab === "today" ? daily.today : daily.yesterday} />
            ) : (
              <div className="muted">Loading daily report…</div>
            )}
          </div>
        </section>

        <section className="panel">
          <h2>Realtime work</h2>
          <div className="msg" style={{ marginTop: 0, marginBottom: 10 }}>
            Live feed of what the worker is doing (updates ~2.5s).
          </div>
          <div className="table-wrap" style={{ maxHeight: 320 }}>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>State</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {activity.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="muted">
                      No activity yet — start the worker to stream status here.
                    </td>
                  </tr>
                ) : (
                  activity.map((e, i) => (
                    <tr key={`${e.at}-${i}`}>
                      <td className="mono" style={{ whiteSpace: "nowrap" }}>
                        {e.at.slice(11, 19)}
                      </td>
                      <td>
                        <span className={`badge ${e.state}`}>{e.state}</span>
                        {e.sceneKind ? (
                          <div className="muted mono" style={{ fontSize: 11 }}>
                            {e.sceneKind}
                            {e.sceneAction ? ` → ${e.sceneAction}` : ""}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div>{e.message}</div>
                        {e.url ? (
                          <div className="muted mono" style={{ fontSize: 11 }}>
                            {e.url.replace("https://www.humanatic.com", "")}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
        <h2>Categories</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Payout</th>
                <th>Calls</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr
                  key={c.id}
                  className={target?.categoryId === c.id ? "active" : undefined}
                >
                  <td className="mono">{c.id}</td>
                  <td>{c.name}</td>
                  <td className="mono">{c.payoutLabel || "—"}</td>
                  <td className="mono">{c.availableCalls || "—"}</td>
                  <td className="muted">{c.lastStatus}</td>
                  <td>
                    <button
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => workCategory(c.id, c.name)}
                    >
                      Work this
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Recent reviews</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Category</th>
                <th>Option</th>
                <th>Conf</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {reviews.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    No reviews logged yet
                  </td>
                </tr>
              ) : (
                reviews.map((r) => (
                  <tr key={`${r.call_id}-${r.timestamp}`}>
                    <td className="mono">{new Date(r.timestamp).toLocaleString()}</td>
                    <td>
                      {r.category_name || r.category_id}
                    </td>
                    <td className="mono">{r.selected_option_id || "—"}</td>
                    <td className="mono">{r.confidence?.toFixed?.(2) ?? r.confidence}</td>
                    <td className="muted">{r.status}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
