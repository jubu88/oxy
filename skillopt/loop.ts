// SkillOpt-style optimization loop (the trainable object is the SYSTEM "skill").
//
// rollout (build each train task with the candidate skill) → score → a stronger
// optimizer model proposes a bounded edit → VALIDATION GATE (accept only if the
// held-out val score strictly improves) → deploy. Pure control flow with injected
// dependencies, so the loop logic is unit-testable without slow real builds.
import type { ScoreBreakdown, Task } from "./score.ts";

export interface Rollout {
  task: Task;
  score: number;
  breakdown: ScoreBreakdown;
  toolSummary: string; // the tool sequence the agent ran (signal for the optimizer)
}

export interface EvalResult {
  score: number; // mean over the tasks (each task's score is the median of its repeats)
  rollouts: Rollout[];
  perTask?: Array<{ id: string; score: number }>; // per-task medians, for the no-regression guard
}

export type OptEvent =
  | { type: "seed"; valScore: number }
  | { type: "rollout"; epoch: number; batch: number; trainScore: number }
  | { type: "candidate"; epoch: number; batch: number; valScore: number; bestScore: number; accepted: boolean };

export interface OptimizeDeps {
  seedSkill: string;
  trainTasks: Task[];
  valTasks: Task[];
  epochs?: number;
  batchSize?: number;
  /** repeats per val task in the gate (median of K); small models are stochastic so K>=3 */
  valRepeats?: number;
  /** accept only if the candidate beats best by more than this noise band (default 0) */
  acceptMargin?: number;
  /** run builds with `skill` on `tasks`, score each, return mean + rollouts. `opts.repeats`
   *  builds each task multiple times and uses the median per-task score. */
  evalSkill: (skill: string, tasks: Task[], opts?: { repeats?: number }) => Promise<EvalResult>;
  /** optimizer model: given the current skill + scored rollouts, return a revised skill */
  proposeEdit: (skill: string, rollouts: Rollout[]) => Promise<string>;
  /** persist the new best skill (e.g. write skill/system.md) */
  deploy?: (skill: string) => Promise<void> | void;
  onEvent?: (e: OptEvent) => void;
}

export interface OptResult {
  bestSkill: string;
  bestScore: number;
  seedScore: number;
  accepted: number;
  history: Array<{ epoch: number; batch: number; trainScore: number; candValScore: number; accepted: boolean }>;
}

export async function optimizeSkill(d: OptimizeDeps): Promise<OptResult> {
  const epochs = d.epochs ?? 1;
  const batchSize = d.batchSize && d.batchSize > 0 ? d.batchSize : d.trainTasks.length;

  const margin = d.acceptMargin ?? 0;
  const valOpts = { repeats: d.valRepeats };

  let best = d.seedSkill;
  const seed = await d.evalSkill(best, d.valTasks, valOpts);
  let bestScore = seed.score;
  let bestPerTask = seed.perTask;
  const seedScore = seed.score;
  d.onEvent?.({ type: "seed", valScore: bestScore });

  const history: OptResult["history"] = [];
  let accepted = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = 0; i < d.trainTasks.length; i += batchSize) {
      const batch = i / batchSize;
      const tasks = d.trainTasks.slice(i, i + batchSize);

      // rollout the CURRENT best on this batch to get failure signal
      const train = await d.evalSkill(best, tasks);
      d.onEvent?.({ type: "rollout", epoch, batch, trainScore: train.score });

      // optimizer proposes a revised skill
      const candidate = (await d.proposeEdit(best, train.rollouts))?.trim();
      if (!candidate || candidate === best) {
        history.push({ epoch, batch, trainScore: train.score, candValScore: bestScore, accepted: false });
        continue;
      }

      // VALIDATION GATE: accept only if the held-out mean beats best by > margin
      // AND no individual val task regresses by more than the margin (a +mean can
      // otherwise mask a real regression on a thin val set).
      const cand = await d.evalSkill(candidate, d.valTasks, valOpts);
      const meanOk = cand.score > bestScore + margin;
      const noRegression =
        !bestPerTask || !cand.perTask
          ? true
          : cand.perTask.every((ct) => {
              const prev = bestPerTask!.find((p) => p.id === ct.id);
              return !prev || ct.score >= prev.score - margin;
            });
      const ok = meanOk && noRegression;
      d.onEvent?.({ type: "candidate", epoch, batch, valScore: cand.score, bestScore, accepted: ok });
      history.push({ epoch, batch, trainScore: train.score, candValScore: cand.score, accepted: ok });

      if (ok) {
        best = candidate;
        bestScore = cand.score;
        bestPerTask = cand.perTask;
        accepted++;
        await d.deploy?.(best);
      }
    }
  }

  return { bestSkill: best, bestScore, seedScore, accepted, history };
}
