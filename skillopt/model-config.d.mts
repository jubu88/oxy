// Type declarations for model-config.mjs (a plain-JS module shared by the .mjs server and
// the .ts promote/supervisor, so it must stay JS — these give the .ts consumers types).

/** Stable, filesystem-safe key for a model ref (skill/<key>.md + the journal `model` tag). */
export function modelKey(ref?: string | null): string;

/** Step (assistant-turn) budget for a model — bigger/slower models get more turns. */
export function maxStepsFor(ref?: string | null): number;
