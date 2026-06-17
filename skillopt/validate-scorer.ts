// Empirical proof that the hardened scorer tells a WORKING app from a dead
// MOCKUP — the entire point of the functional interaction checks. For each
// pair we hand-write a working build and a look-alike static build, score both
// against the same task, and assert the working one wins by ~the functional
// weight. Run: node skillopt/validate-scorer.ts   (needs Playwright)
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scoreProject, type Task } from "./score.ts";

function projectWith(html: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oxy-scorecheck-"));
  writeFileSync(path.join(dir, "index.html"), html, "utf8");
  return dir;
}

const COUNTER: Task = {
  id: "counter",
  prompt: "counter",
  checks: { selectors: ["button"], textIncludes: ["0"], interactions: [{ steps: [{ clickText: "+" }], expect: [{ changed: true, label: "clicking + changes the number" }] }] },
};
const TODO: Task = {
  id: "todo",
  prompt: "todo",
  checks: { selectors: ["input", "button", "ul, ol"], textIncludes: ["add"], interactions: [{ steps: [{ fill: { selector: "input", value: "Buy milk" } }, { clickText: "Add" }], expect: [{ contains: "Buy milk" }] }] },
};
const CLOCK: Task = {
  id: "clock",
  prompt: "clock",
  checks: { textIncludes: [":"], interactions: [{ steps: [{ waitMs: 1200 }], expect: [{ changed: true, label: "clock advances" }] }] },
};

const WORKING_COUNTER = `<!doctype html><meta charset=utf8><title>Counter</title>
<h1 id=n>0</h1><button id=p>+</button><button id=m>-</button>
<script>let c=0,n=document.getElementById('n');
p.onclick=()=>n.textContent=++c; m.onclick=()=>n.textContent=--c;</script>`;
const MOCKUP_COUNTER = `<!doctype html><meta charset=utf8><title>Counter</title>
<h1>0</h1><button>+</button><button>-</button>`; // looks identical, buttons do nothing

const WORKING_TODO = `<!doctype html><meta charset=utf8><title>Todo</title>
<input id=i><button id=a>Add</button><ul id=l></ul>
<script>a.onclick=()=>{let li=document.createElement('li');li.textContent=i.value;l.appendChild(li);}</script>`;
const MOCKUP_TODO = `<!doctype html><meta charset=utf8><title>Todo</title>
<input><button>Add</button><ul></ul>`; // Add does nothing

const WORKING_CLOCK = `<!doctype html><meta charset=utf8><title>Clock</title>
<h1 id=t></h1><script>function u(){t.textContent=new Date().toLocaleTimeString()}u();setInterval(u,1000);</script>`;
const STATIC_CLOCK = `<!doctype html><meta charset=utf8><title>Clock</title><h1>12:00:00</h1>`; // never updates

const PAIRS = [
  { name: "counter", task: COUNTER, working: WORKING_COUNTER, mockup: MOCKUP_COUNTER },
  { name: "todo", task: TODO, working: WORKING_TODO, mockup: MOCKUP_TODO },
  { name: "clock", task: CLOCK, working: WORKING_CLOCK, mockup: STATIC_CLOCK },
];

const main = async () => {
  console.log("\n=== scorer validation: working vs mockup ===\n");
  let failures = 0;
  for (const p of PAIRS) {
    const wd = projectWith(p.working);
    const md = projectWith(p.mockup);
    try {
      const w = await scoreProject(wd, p.task, { finished: true });
      const m = await scoreProject(md, p.task, { finished: true });
      const gap = +(w.score - m.score).toFixed(3);
      const ok = w.score > m.score + 0.2; // mockup must lose by roughly the functional weight
      if (!ok) failures++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${p.name.padEnd(8)} working ${w.score.toFixed(2)}  (func ${w.breakdown.functional.toFixed(2)})  vs  mockup ${m.score.toFixed(2)}  (func ${m.breakdown.functional.toFixed(2)})  Δ ${gap}`);
      if (m.breakdown.notes.length) console.log(`        mockup notes: ${m.breakdown.notes.join("; ")}`);
    } finally {
      rmSync(wd, { recursive: true, force: true });
      rmSync(md, { recursive: true, force: true });
    }
  }
  console.log(`\n${failures === 0 ? "ALL PASS — the scorer separates working apps from mockups." : `${failures} FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
};
main();
