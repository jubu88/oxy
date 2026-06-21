// Parse the auto-promote log (~/.oxy/auto-promote.log) into a structured status the
// UI can render: phase, per-task benchmark scores for the current vs candidate skill,
// and the outcome (deployed / rejected). The log is APPENDED across runs, so we parse
// only the most recent run (from its last header). Pure + unit-tested; the server wraps
// it with file reads, a running flag, a timer, and journal stats.

const HEADER = "=== Oxy SkillOpt · gated promote ===";

export function parseAutoPromoteLog(text) {
  const st = {
    found: false,
    phase: "idle", // starting | reviewing | scoring-current | optimizing | scoring-candidate | done
    finished: false,
    deployed: null, // true=accepted, false=rejected/no-change, null=undecided
    outcome: null, // "skill improved" | "no change" | null
    valTotal: null,
    repeats: null,
    reviewed: null,
    finishRate: null, // 0..100
    base: { score: null, perTask: [] },
    candidate: { score: null, perTask: [], proposed: null },
  };
  if (!text || typeof text !== "string") return st;
  const lines = text.split(/\r?\n/);
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(HEADER)) {
      start = i;
      break;
    }
  }
  if (!lines.some((l) => l.includes(HEADER))) return st; // no run logged yet
  st.found = true;
  st.phase = "starting";
  let bucket = null; // where indented "task: score (runs)" lines land
  for (const line of lines.slice(start)) {
    let m;
    if ((m = line.match(/journal:\s*(\d+)\s*fresh.*?val:\s*(\d+).*?repeats:\s*(\d+)/))) {
      st.reviewed = Number(m[1]);
      st.valTotal = Number(m[2]);
      st.repeats = Number(m[3]);
    } else if ((m = line.match(/Real builds reviewed:\s*(\d+)\s*·\s*finished rate\s*(\d+)%/))) {
      st.reviewed = Number(m[1]);
      st.finishRate = Number(m[2]);
    } else if (/scoring current skill/.test(line)) {
      st.phase = "scoring-current";
      bucket = st.base.perTask;
    } else if (/asking optimizer|optimizer for a journal/.test(line)) {
      st.phase = "optimizing";
      bucket = null;
    } else if (/scoring the candidate/.test(line)) {
      st.phase = "scoring-candidate";
      st.candidate.proposed = true;
      bucket = st.candidate.perTask;
    } else if ((m = line.match(/current skill val:\s*([\d.]+)/))) {
      st.base.score = Number(m[1]);
    } else if ((m = line.match(/candidate val\s*([\d.]+)\s*vs current\s*([\d.]+)/))) {
      st.candidate.score = Number(m[1]);
      if (st.base.score == null) st.base.score = Number(m[2]);
    } else if (/optimizer proposed no change/.test(line)) {
      st.candidate.proposed = false;
      st.deployed = false;
    } else if (/ACCEPTED/.test(line)) {
      st.deployed = true;
    } else if (/\]\s*rejected\b/.test(line)) {
      st.deployed = false;
    } else if ((m = line.match(/promote done\s*[—-]+\s*(.+?)\s*=+/))) {
      st.finished = true;
      st.outcome = m[1].trim();
      st.phase = "done";
      if (st.deployed == null) st.deployed = /improv/i.test(st.outcome);
    } else if (bucket && (m = line.match(/^\s+([A-Za-z0-9_-]+):\s*([\d.]+)\s*\([\d./]+\)\s*$/))) {
      bucket.push({ id: m[1], score: Number(m[2]) });
    }
  }
  return st;
}

// Total benchmark builds expected = base pass + (candidate pass, once proposed), each
// valTotal tasks. Used for an x/y progress bar. Returns null when we can't tell yet.
export function autoLearnProgress(st) {
  if (!st || !st.found || !st.valTotal) return null;
  const perPass = st.valTotal;
  const candidateExpected = st.candidate.proposed === false ? 0 : st.candidate.proposed ? perPass : 0;
  const total = perPass + candidateExpected;
  const done = st.base.perTask.length + st.candidate.perTask.length;
  return { done, total: Math.max(total, done), perPass };
}
