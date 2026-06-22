// Types for sanitize.mjs (plain-JS deterministic repair pass, shared by .mjs + .ts callers).
export function sanitizeFileContent(relPath: string, content: string): { content: string; fixes: string[] };
export function sanitizeProject(projectDir: string): string[];
export function repairModuleScripts(projectDir: string): string[];
export function dedupeClasses(code: string): { code: string; fixes: string[] };
export function mergeDuplicateClasses(projectDir: string): string[];
export function repairAttrCallback(code: string): { code: string; fixes: string[] };
export function fixAttrCallbacks(projectDir: string): string[];
export function injectSupabaseConfig(projectDir: string, url: string, anonKey: string): string[];
export function verifyProject(projectDir: string): string[];
