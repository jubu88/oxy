import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Vite plugin mounting the jailed backend + Oxy build endpoints under /codelab/* and /oxy/*. */
export function codeLabPlugin(): Plugin;

/** Connect-style request handler (used by the Vite plugin and the standalone launcher). */
export function codelabHandler(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void>;

/** Ensure the workspace/projects directory exists. */
export function ensure(): void;

/** Generate a page design with Google Stitch and return its HTML. */
export function stitchGenerate(
  prompt: string,
  opts?: { deviceType?: "DESKTOP" | "MOBILE"; designSystem?: string; title?: string },
): Promise<{ html: string; stitchProjectId: string; seconds: number }>;
