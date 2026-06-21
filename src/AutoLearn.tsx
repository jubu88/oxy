// Live view of the continuous-improvement ("auto-learn") background process: an ON
// indicator so it's never invisible, progress (x/y benchmark builds + a timer), the
// current-vs-candidate scores, the pass/fail outcome, and what it's learning from your
// real builds. Polls /codelab/api/autolearn; collapses to a single line when idle.
import { useEffect, useState } from "react";
import { getAutoLearn, type AutoLearnStatus } from "./api.ts";

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const PHASE_LABEL: Record<string, string> = {
  starting: "starting…",
  "scoring-current": "scoring the current skill",
  optimizing: "asking the optimizer for an edit",
  "scoring-candidate": "scoring the candidate skill",
  done: "done",
  idle: "idle",
};

export function AutoLearn() {
  const [data, setData] = useState<AutoLearnStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const d = await getAutoLearn();
      if (alive) setData(d);
    };
    tick();
    const id = window.setInterval(tick, 4000); // also catches the moment a run TURNS ON
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // smooth 1s timer while running (the poll is only every 4s)
  useEffect(() => {
    if (!data?.running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [data?.running]);

  if (!data || (!data.running && !data.status.found)) return null;

  const st = data.status;
  const running = data.running;
  const prog = data.progress;
  const elapsed = running && data.startedAt ? now - data.startedAt : null;
  const pct = prog && prog.total ? Math.min(100, Math.round((prog.done / prog.total) * 100)) : 0;

  const resultText = st.finished
    ? st.deployed
      ? "last run: skill improved ✓ deployed"
      : st.candidate.proposed === false
        ? "last run: no change (optimizer proposed nothing)"
        : "last run: no change (candidate didn't beat the current skill)"
    : "idle";

  return (
    <section className={"autolearn" + (running ? " running" : "")}>
      <button type="button" className="al-head" onClick={() => setOpen((o) => !o)} title="continuous skill improvement from your real builds">
        <span className={"al-dot" + (running ? " on" : "")} />
        <span className="al-title">Auto-learn{st.model ? ` · ${st.model}` : ""}</span>
        <span className={"al-state" + (running ? "" : " muted")}>{running ? PHASE_LABEL[st.phase] ?? st.phase : resultText}</span>
        <span className="al-spacer" />
        {running && elapsed != null && <span className="al-timer">{fmtClock(elapsed)}</span>}
        <span className="material-symbols-outlined al-caret">{open ? "expand_less" : "expand_more"}</span>
      </button>

      {running && prog && (
        <div className="al-prog">
          <div className="al-bar">
            <div className="al-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="al-count">
            {prog.done}/{prog.total} builds{prog.total > prog.done ? ` · ${prog.total - prog.done} to go` : ""}
          </span>
        </div>
      )}

      {(running || st.finished) && (st.base.score != null || st.candidate.score != null) && (
        <div className="al-scores">
          {st.base.score != null && (
            <span className="al-score">
              current <b>{st.base.score.toFixed(2)}</b>
            </span>
          )}
          {st.candidate.score != null && (
            <span className="al-score">
              candidate <b className={st.candidate.score >= (st.base.score ?? 0) ? "up" : "down"}>{st.candidate.score.toFixed(2)}</b>
            </span>
          )}
          {st.candidate.proposed === false && <span className="al-score muted">no candidate proposed</span>}
        </div>
      )}

      {open && (
        <div className="al-details">
          <div className="al-row">
            <span>cadence</span>
            <span>every {data.every} builds{data.disabled ? " · disabled" : data.autoLearn ? "" : " · auto-learn off"}</span>
          </div>
          {data.journal.unconsumed > 0 && (
            <div className="al-row">
              <span>journal</span>
              <span>
                {data.journal.unconsumed} new lesson{data.journal.unconsumed === 1 ? "" : "s"}
                {data.journal.finishRate != null ? ` · ${data.journal.finishRate}% of builds finished` : ""}
              </span>
            </div>
          )}
          {data.journal.topMistakes.length > 0 && (
            <div className="al-learned">
              <div className="al-learned-title">what it's learning from your builds</div>
              <ul>
                {data.journal.topMistakes.map((m, i) => (
                  <li key={i}>
                    <span className="al-x">{m.count}×</span> {m.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(st.base.perTask.length > 0 || st.candidate.perTask.length > 0) && (
            <div className="al-learned">
              <div className="al-learned-title">benchmark — current{st.candidate.perTask.length ? " → candidate" : ""}</div>
              <div className="al-task-grid">
                {st.base.perTask.map((t) => {
                  const c = st.candidate.perTask.find((x) => x.id === t.id);
                  return (
                    <div key={t.id} className="al-task">
                      <code>{t.id}</code>
                      <span>
                        {t.score.toFixed(2)}
                        {c ? <b className={c.score >= t.score ? " up" : " down"}> → {c.score.toFixed(2)}</b> : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
