// Curated, coherent design systems. Small models style ad-hoc (clashing colors,
// random spacing, emoji icons); handing them a ready-to-paste token set fixes the
// single biggest "looks amateur" tell. Each returns a complete, drop-in :root block.
// Returned verbatim by the get_design_system tool (see executor.ts).
export const DESIGN_SYSTEMS: Record<string, string> = {
  "modern-saas": `Style: Modern SaaS — clean, trustworthy, indigo accent.
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
:root{
  --bg:#f8fafc; --surface:#ffffff; --text:#0f172a; --muted:#64748b; --border:#e2e8f0;
  --primary:#4f46e5; --primary-fg:#ffffff; --accent:#06b6d4;
  --font:'Inter',system-ui,sans-serif; --display:'Inter',sans-serif;
  --radius:10px; --shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(15,23,42,.06);
  --space:8px;
}
Use: body background var(--bg), cards var(--surface)+var(--border)+var(--radius)+var(--shadow), buttons var(--primary)/var(--primary-fg), headings var(--display) weight 700.`,

  "warm-artisan": `Style: Warm Artisan — cozy, handcrafted, cream + terracotta, serif headings.
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Lato:wght@400;700&display=swap" rel="stylesheet">
:root{
  --bg:#f5f0e8; --surface:#fffdf9; --text:#3a2e25; --muted:#8a7a6a; --border:#e6dccd;
  --primary:#b25d33; --primary-fg:#fffdf9; --accent:#6f7d4e;
  --font:'Lato',system-ui,sans-serif; --display:'Playfair Display',serif;
  --radius:8px; --shadow:0 2px 10px rgba(58,46,37,.08);
  --space:8px;
}
Use: serif var(--display) for headings, var(--primary) terracotta for CTAs, generous padding, soft shadows.`,

  "playful": `Style: Playful — bright, rounded, energetic.
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;700;800&display=swap" rel="stylesheet">
:root{
  --bg:#fff7ed; --surface:#ffffff; --text:#1f2937; --muted:#6b7280; --border:#fde68a;
  --primary:#f97316; --primary-fg:#ffffff; --accent:#8b5cf6;
  --font:'Poppins',system-ui,sans-serif; --display:'Poppins',sans-serif;
  --radius:20px; --shadow:0 10px 30px rgba(249,115,22,.18);
  --space:10px;
}
Use: big radii, bold weights (800 headings), vivid var(--primary)/var(--accent), chunky buttons.`,

  "minimal-mono": `Style: Minimal Monochrome — black/white, lots of whitespace, sharp.
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
:root{
  --bg:#ffffff; --surface:#ffffff; --text:#111111; --muted:#777777; --border:#111111;
  --primary:#111111; --primary-fg:#ffffff; --accent:#111111;
  --font:'Space Grotesk',system-ui,sans-serif; --display:'Space Grotesk',sans-serif;
  --radius:0px; --shadow:none;
  --space:12px;
}
Use: hairline 1px var(--border) borders, no shadows, square corners, huge whitespace, black buttons.`,

  "dark-dashboard": `Style: Dark Dashboard — deep surfaces, neon accent.
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
:root{
  --bg:#0b0f1a; --surface:#141a29; --text:#e5e9f0; --muted:#8b95a7; --border:#232a3b;
  --primary:#3b82f6; --primary-fg:#ffffff; --accent:#22d3ee;
  --font:'Inter',system-ui,sans-serif; --display:'Inter',sans-serif;
  --radius:12px; --shadow:0 8px 30px rgba(0,0,0,.4);
  --space:8px;
}
Use: dark var(--bg), elevated var(--surface) cards, var(--accent) cyan highlights, glowing primary buttons.`,
};
