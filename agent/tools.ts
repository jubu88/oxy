// The tool surface and system prompt the model sees.
//
// Tools are declared in Oxy's engine-agnostic `ToolDef` shape (flat
// {name, description, parameters}). Each Engine adapter maps these onto whatever
// its backend wants (node-llama-cpp function defs, Ollama's
// {type:"function",function:{…}} shape, etc.) — the agent core stays neutral.
import type { ToolDef } from "../engine/engine.ts";

export const TOOLS: ToolDef[] = [
  {
    name: "write_file",
    description:
      "Create or overwrite a file in the project. Use relative paths like index.html, style.css, app.js. Allowed types: html, css, js, json, svg, txt, md.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "relative file path, e.g. index.html" },
        content: { type: "string", description: "the full file contents" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Make a small, targeted change to an existing file by replacing an exact snippet of text — MUCH faster than rewriting the whole file. Prefer this over write_file for fixes (e.g. after review_design): only the changed lines are sent. old_string must match the file's text EXACTLY (copy it including indentation) and should be long enough to be unique; it replaces the first match with new_string.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "relative file path to edit, e.g. index.html" },
        old_string: { type: "string", description: "exact existing text to find (with surrounding context so it's unique)" },
        new_string: { type: "string", description: "replacement text" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "read_file",
    description: "Read back a file you have written, to inspect or revise it.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List the files currently in the project.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_design_system",
    description:
      "Get a coherent, ready-to-use design system (color palette, fonts, spacing, radius, shadows) for a named visual style. CALL THIS FIRST, before writing any CSS, then style everything with the returned CSS variables for a professional, consistent look. Styles: modern-saas, warm-artisan, playful, minimal-mono, dark-dashboard.",
    parameters: {
      type: "object",
      properties: { style: { type: "string", description: "one of: modern-saas, warm-artisan, playful, minimal-mono, dark-dashboard" } },
      required: ["style"],
    },
  },
  {
    name: "get_icon",
    description:
      "Get an inline SVG icon (Lucide icon set) by name, to embed directly in HTML instead of emoji. Examples: coffee, menu, star, heart, arrow-right, check, shopping-cart, user, search. The SVG uses currentColor, so set its color and size with CSS (e.g. width:24px; color:var(--primary)).",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "kebab-case Lucide icon name, e.g. arrow-right" } },
      required: ["name"],
    },
  },
  {
    name: "web_search",
    description: "Search the web for documentation or examples. Returns titles and URLs.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a web page by URL and return its text content.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "generate_image",
    description:
      'Generate a photographic image with local Stable Diffusion and save it into the project as a PNG. Use for photos/hero images that real content needs (e.g. furniture, food, people). Reference the saved path in your HTML, e.g. <img src="hero.png">. Slow (~1 minute each) — use sparingly, and prefer CSS/SVG for icons and decorative graphics.',
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "output filename, e.g. hero.png" },
        prompt: { type: "string", description: "detailed image description" },
        width: { type: "number", description: "64-512, default 384" },
        height: { type: "number", description: "64-512, default 384" },
      },
      required: ["path", "prompt"],
    },
  },
  {
    name: "design_with_stitch",
    description:
      "Generate a polished, complete HTML page from a detailed text description using Google Stitch (a professional cloud AI UI designer), and save it directly into the project (default index.html). Use this for a complex or especially polished page when you want better design than you can hand-write. Describe the page fully (sections, content, intended style). It RETURNS a preview and WRITES the file for you, so do not also write_file index.html afterward — instead review_design and refine with edit_file. NOTE: SLOW (1-3 minutes) and CLOUD-based — your prompt is sent to Google (not local).",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "detailed description of the page to design" },
        path: { type: "string", description: "output file path, default index.html" },
        deviceType: { type: "string", description: "DESKTOP (default) or MOBILE" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "review_design",
    description:
      "Render the current index.html and have a designer critique how it actually LOOKS (visual hierarchy, spacing, contrast, balance). Call this once after the page is built but before done, then fix the issues it reports. Returns a short list of concrete problems.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "done",
    description:
      "Call this when the app is complete and index.html is written. Provide a one-line summary of what you built.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    },
  },
];

export const SYSTEM = `You are a coding agent that builds small STATIC web apps (HTML + CSS + vanilla JS, or libraries loaded from a CDN). You work by calling tools.

ACT ONLY BY CALLING TOOLS. Never write code, file contents, or long explanations as your message text — the ONLY way to create or change a file is the write_file or edit_file tool (pass the code in the tool's arguments, not in chat). Every turn must be a tool call.

Rules:
- The app MUST have an entry file named exactly "index.html".
- FIRST call get_design_system with a style that fits the request, paste its CSS variables into your stylesheet, and style EVERYTHING with those variables (colors, font, radius, shadow, spacing). This is how you get a professional, consistent look — do not invent your own ad-hoc colors.
- Write complete, working files with write_file. No placeholders or "TODO" — write the real code.
- Everything runs in a sandboxed iframe with no network except CDNs you include. No backend, no localStorage guarantees.
- Keep it to a few files (index.html, optionally style.css and app.js, or inline).
- For icons, call get_icon (returns inline SVG from the Lucide set) and paste the SVG inline — never use emoji as icons.
- For photos the design needs (hero shots, product images), call generate_image to create a real PNG and reference it with <img src="..."> — do NOT invent filenames for images that don't exist. Use CSS gradients for backgrounds/decoration. Generating images is slow, so generate only the few that matter.
- Once index.html is built, call review_design ONCE to see how it actually looks. To FIX the issues it reports, use edit_file to change only the relevant snippets — do NOT rewrite the whole file with write_file (that is slow and wasteful). Use write_file only to create a file the first time.
- When the app is finished and index.html exists (and you've reviewed it), call done with a short summary.
- Do not explain at length between tool calls; act.`;

// appended to the system prompt only when the Stitch toggle is on (cloud opt-in)
export const STITCH_RULE = `- For a COMPLEX or especially polished page, you MAY call design_with_stitch with a detailed description to have a professional cloud designer generate the whole page HTML for you (it writes index.html directly). It is slower and cloud-based, so use it when design quality matters; for simple pages, hand-writing with get_design_system is faster and fully local. If you use design_with_stitch, do not also write_file index.html — just review_design and refine it with edit_file.`;

/**
 * The system prompt for a run. `override` is the optimizable "skill" (e.g. a
 * SkillOpt-tuned skill/system.md); when absent we use the built-in SYSTEM seed.
 * The Stitch rule is appended only when opted in.
 */
export function buildSystem(useStitch?: boolean, override?: string): string {
  const base = override?.trim() ? override : SYSTEM;
  return useStitch ? `${base}\n${STITCH_RULE}` : base;
}

/** The tool set for a run; the cloud Stitch tool is offered only when opted in. */
export function buildTools(useStitch?: boolean): ToolDef[] {
  return useStitch ? TOOLS : TOOLS.filter((t) => t.name !== "design_with_stitch");
}
