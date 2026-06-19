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

  brutalist: `Style: Neo-Brutalist — raw, high-contrast, thick borders, hard offset shadows.
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;900&display=swap" rel="stylesheet">
:root{
  --bg:#fdf6b2; --surface:#ffffff; --text:#000000; --muted:#444444; --border:#000000;
  --primary:#ff5470; --primary-fg:#000000; --accent:#00e0c6;
  --font:'Archivo',system-ui,sans-serif; --display:'Archivo',sans-serif;
  --radius:0px; --shadow:6px 6px 0 #000000;
  --space:10px;
}
Use: thick 3px var(--border) borders on everything, hard offset var(--shadow) (no blur), square corners, heavy 900 headings, bold blocks of var(--primary)/var(--accent).`,

  glass: `Style: Glassmorphism — frosted translucent panels over a vivid gradient.
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet">
:root{
  --bg:linear-gradient(135deg,#6d5efc 0%,#c850c0 50%,#ffcc70 100%); --surface:rgba(255,255,255,.14); --text:#ffffff; --muted:rgba(255,255,255,.72); --border:rgba(255,255,255,.28);
  --primary:#ffffff; --primary-fg:#6d5efc; --accent:#ffe066;
  --font:'Plus Jakarta Sans',system-ui,sans-serif; --display:'Plus Jakarta Sans',sans-serif;
  --radius:18px; --shadow:0 8px 32px rgba(31,38,135,.25);
  --space:10px;
}
Use: body{min-height:100vh; background:var(--bg)}. Cards = var(--surface) + backdrop-filter:blur(12px) + 1px var(--border) + var(--radius). White text, frosted buttons.`,

  editorial: `Style: Editorial — magazine layout, elegant serif headlines, red accent, airy.
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Inter:wght@400;500&display=swap" rel="stylesheet">
:root{
  --bg:#fbfaf7; --surface:#ffffff; --text:#1a1a1a; --muted:#6b6b6b; --border:#e3e0d8;
  --primary:#c0392b; --primary-fg:#ffffff; --accent:#c0392b;
  --font:'Inter',system-ui,sans-serif; --display:'Fraunces',Georgia,serif;
  --radius:4px; --shadow:0 1px 2px rgba(0,0,0,.05);
  --space:10px;
}
Use: big var(--display) serif headlines (700), roomy line-height (1.7) body, thin rules, var(--primary) red links/accents, strong vertical rhythm.`,

  terminal: `Style: Terminal — retro CRT, green phosphor on black, monospace.
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
:root{
  --bg:#0a0e0a; --surface:#0e140e; --text:#33ff66; --muted:#1f8a3d; --border:#1f8a3d;
  --primary:#33ff66; --primary-fg:#0a0e0a; --accent:#aaffaa;
  --font:'JetBrains Mono',ui-monospace,monospace; --display:'JetBrains Mono',monospace;
  --radius:2px; --shadow:0 0 12px rgba(51,255,102,.25);
  --space:10px;
}
Use: black var(--bg), monospace everywhere, glowing var(--primary) green text/borders, thin green outlines, subtle text-shadow glow, blocky accents.`,

  organic: `Style: Organic Nature — earthy greens, warm neutrals, soft and calm.
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700&family=Bitter:wght@600;700&display=swap" rel="stylesheet">
:root{
  --bg:#f3f1e7; --surface:#fbfaf4; --text:#2f3a2c; --muted:#7c8a72; --border:#dfe3d2;
  --primary:#4a7c59; --primary-fg:#ffffff; --accent:#c98a3b;
  --font:'Nunito',system-ui,sans-serif; --display:'Bitter',serif;
  --radius:14px; --shadow:0 4px 16px rgba(47,58,44,.08);
  --space:10px;
}
Use: leafy var(--primary) green CTAs, warm var(--accent) ochre highlights, rounded organic cards, soft shadows, serif var(--display) headings.`,

  corporate: `Style: Corporate — professional navy + slate, conservative and trustworthy.
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
:root{
  --bg:#f4f6f9; --surface:#ffffff; --text:#1b2a4a; --muted:#5b6b85; --border:#d6dde8;
  --primary:#1b3a8a; --primary-fg:#ffffff; --accent:#0a8f6b;
  --font:'IBM Plex Sans',system-ui,sans-serif; --display:'IBM Plex Sans',sans-serif;
  --radius:6px; --shadow:0 1px 3px rgba(27,42,74,.1),0 4px 12px rgba(27,42,74,.06);
  --space:8px;
}
Use: deep navy var(--primary), restrained var(--accent) green, tidy cards, subtle shadows, 600 headings, structured grid — enterprise/banking feel.`,

  vibrant: `Style: Vibrant Gradient — bold purple→pink gradients, glossy modern startup.
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&display=swap" rel="stylesheet">
:root{
  --bg:#0f0820; --surface:#1b1130; --text:#f5f0ff; --muted:#a99fc4; --border:#34254f;
  --primary:#a855f7; --primary-fg:#ffffff; --accent:#ec4899;
  --font:'Sora',system-ui,sans-serif; --display:'Sora',sans-serif;
  --radius:16px; --shadow:0 10px 40px rgba(168,85,247,.3);
  --space:10px;
}
Use: dark var(--bg); gradient buttons/headlines via linear-gradient(var(--primary),var(--accent)); glowing shadows; big bold 800 headings; glassy cards.`,
};
