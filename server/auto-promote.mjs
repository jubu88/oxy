// Pure decision for the gated auto-promote trigger (see server.mjs `maybeAutoPromote`).
// Extracted and SIDE-EFFECT-FREE so the threshold/guard logic can be unit-tested
// without spawning the real (slow) benchmark.
//
// Self-improvement must fire EXACTLY when ALL hold:
//   - enough fresh journaled lessons have banked (fresh >= every), AND
//   - no build is in flight (activeBuilds === 0 — never contend with the user's
//     build for the single llama-server slot), AND
//   - no promote is already running (no double-spawn), AND
//   - the feature isn't disabled (OXY_AUTO_PROMOTE=0 / Settings "auto-learn" off).
export function shouldAutoPromote({ fresh, every, promoteRunning = false, activeBuilds = 0, disabled = false }) {
  if (disabled || promoteRunning || activeBuilds > 0) return false;
  if (!Number.isFinite(fresh) || !Number.isFinite(every) || every <= 0) return false;
  return fresh >= every;
}
