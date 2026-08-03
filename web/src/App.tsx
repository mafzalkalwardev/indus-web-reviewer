import { useCallback, useEffect, useState } from "react";
import {
  api,
  Category,
  Review,
  Stats,
  WorkerStatus,
  WorkerTarget,
} from "./api";

export default function App() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [target, setTarget] = useState<WorkerTarget | null>(null);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [cats, revs, st, stat, tgt] = await Promise.all([
        api.categories(),
        api.reviews(40),
        api.stats(),
        api.status(),
        api.target(),
      ]);
      setCategories(cats);
      setReviews(revs);
      setStats(st);
      setStatus(stat);
      setTarget(tgt);
      setError("");
    } catch (e) {
      setError((e as Error).message || "API unreachable — start Control API on :3847");
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, [refresh]);

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
        <div className="row">
          <span className={`badge ${stateClass}`}>{status?.state || "…"}</span>
          <button className="btn btn-primary" disabled={busy} onClick={start}>
            Start worker
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={stop}>
            Stop
          </button>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="panel stat">
          <div className="label">Est. earnings</div>
          <div className="value">{stats?.estimatedEarningsLabel ?? "—"}</div>
        </div>
        <div className="panel stat">
          <div className="label">Submitted</div>
          <div className="value">{stats?.submitted ?? "—"}</div>
        </div>
        <div className="panel stat">
          <div className="label">Accuracy proxy</div>
          <div className="value">
            {stats ? `${Math.round(stats.accuracyProxy * 100)}%` : "—"}
          </div>
        </div>
        <div className="panel stat">
          <div className="label">Skipped</div>
          <div className="value">{stats?.skipped ?? "—"}</div>
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
                min={15}
                max={120}
                value={target?.refreshSeconds ?? 30}
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
          </div>

          <div className="msg">
            {status?.message || "—"}
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
          <h2>How it works</h2>
          <ol className="muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
            <li>Select a category and press Start worker (opens your Chrome profile).</li>
            <li>Tampermonkey polls the API and refreshes that queue until a call appears.</li>
            <li>The wait worker does not spam navigation — it only acts on the review screen.</li>
            <li>Whisper listens, Grok answers, then practice-select or live submit.</li>
          </ol>
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
