// Types for reference.mjs (plain-JS so the .mjs server and .ts promote/supervisor share it).
export const REFERENCE_LIBRARIES: Record<string, string>;
export function parseSections(md: string): Array<{ heading: string; body: string }>;
export function pickReference(md: string, topic: string): { match: Array<{ heading: string; body: string }> | null; topics: string[] };
export function getReference(refDir: string, library: string, topic: string): { ok: boolean; text?: string; error?: string; topics?: string[] };
/** The library-aware build nudge for a task ("" when no known library is detected). */
export function libraryHint(text: string): string;
