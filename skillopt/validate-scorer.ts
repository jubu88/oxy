// Empirical proof that the hardened scorer tells a WORKING app from a dead
// MOCKUP — the entire point of the functional interaction checks. For each
// interactive task we hand-write a working build and a look-alike static build,
// score BOTH against that task's REAL spec from tasks.json, and assert the
// working one wins by ~the functional weight. This also confirms the interaction
// checks are satisfiable by a correct app (i.e. not over-tight): if a working
// build can't clear a check, the check is wrong, not the model.
// Run: node skillopt/validate-scorer.ts   (needs Playwright)
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scoreProject, type Task } from "./score.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tasksFile = JSON.parse(readFileSync(path.join(HERE, "tasks.json"), "utf8"));
const ALL: Task[] = [...tasksFile.train, ...tasksFile.val];
const task = (id: string): Task => {
  const t = ALL.find((x) => x.id === id);
  if (!t) throw new Error(`task ${id} not in tasks.json`);
  return t;
};

function projectWith(html: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oxy-scorecheck-"));
  writeFileSync(path.join(dir, "index.html"), html, "utf8");
  return dir;
}

// Each pair: a genuinely working build vs a static look-alike that satisfies the
// element/text checks but does nothing. The working one must clear the task's
// interaction post-conditions; the mockup must fail them.
const PAIRS: Array<{ id: string; working: string; mockup: string }> = [
  {
    id: "counter",
    working: `<!doctype html><meta charset=utf8><title>Counter</title>
<h1 id=n>0</h1><button id=p>+</button><button id=m>-</button>
<script>let c=0,n=document.getElementById('n');p.onclick=()=>n.textContent=++c;m.onclick=()=>n.textContent=--c;</script>`,
    mockup: `<!doctype html><meta charset=utf8><title>Counter</title><h1>0</h1><button>+</button><button>-</button>`,
  },
  {
    id: "todo",
    working: `<!doctype html><meta charset=utf8><title>Todo</title>
<input id=i><button id=a>Add</button><ul id=l></ul>
<script>a.onclick=()=>{let li=document.createElement('li');li.textContent=i.value;l.appendChild(li);}</script>`,
    mockup: `<!doctype html><meta charset=utf8><title>Todo</title><input><button>Add</button><ul></ul>`,
  },
  {
    id: "clock",
    working: `<!doctype html><meta charset=utf8><title>Clock</title>
<h1 id=t></h1><script>function u(){t.textContent=new Date().toLocaleTimeString()}u();setInterval(u,1000);</script>`,
    mockup: `<!doctype html><meta charset=utf8><title>Clock</title><h1>12:00:00</h1>`,
  },
  {
    id: "calculator",
    working: `<!doctype html><meta charset=utf8><title>Calc</title>
<div id=d>0</div>
<button>7</button><button>3</button><button>+</button><button>=</button>
<script>let cur='',a=null,op=null,d=document.getElementById('d');
document.querySelectorAll('button').forEach(b=>b.onclick=()=>{const t=b.textContent;
if(t==='='){if(op==='+')d.textContent=String(Number(a)+Number(cur));}
else if(t==='+'){a=cur||d.textContent;op='+';cur='';}
else{cur+=t;d.textContent=cur;}});</script>`,
    mockup: `<!doctype html><meta charset=utf8><title>Calc</title><div>0</div><button>7</button><button>3</button><button>+</button><button>=</button>`,
  },
  {
    id: "tabs",
    working: `<!doctype html><meta charset=utf8><title>Tabs</title>
<button onclick="show(0)">Overview</button><button onclick="show(1)">Features</button><button onclick="show(2)">Pricing</button>
<div class=p>Overview details</div><div class=p>Features details</div><div class=p>Pricing details</div>
<script>const ps=document.querySelectorAll('.p');function show(i){ps.forEach((p,j)=>p.style.display=j===i?'block':'none')}show(0);</script>`,
    mockup: `<!doctype html><meta charset=utf8><title>Tabs</title>
<button>Overview</button><button>Features</button><button>Pricing</button>
<div>Overview details</div><div>Features details</div><div>Pricing details</div>`,
  },
  {
    id: "charcount",
    working: `<!doctype html><meta charset=utf8><title>Chars</title>
<input id=i><div id=c>0 characters</div>
<script>i.oninput=()=>c.textContent=i.value.length+' characters';</script>`,
    mockup: `<!doctype html><meta charset=utf8><title>Chars</title><input><div>0 characters</div>`,
  },
];

const main = async () => {
  console.log("\n=== scorer validation: working vs mockup (real tasks.json checks) ===\n");
  let failures = 0;
  for (const p of PAIRS) {
    const t = task(p.id);
    const wd = projectWith(p.working);
    const md = projectWith(p.mockup);
    try {
      const w = await scoreProject(wd, t, { finished: true });
      const m = await scoreProject(md, t, { finished: true });
      const gap = +(w.score - m.score).toFixed(3);
      // working must clear its functional checks (proves the check isn't over-tight)
      // AND beat the mockup by ~the functional weight
      const checkOk = w.breakdown.functional >= 0.999;
      const sepOk = w.score > m.score + 0.2;
      const ok = checkOk && sepOk;
      if (!ok) failures++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${p.id.padEnd(11)} working ${w.score.toFixed(2)} (func ${w.breakdown.functional.toFixed(2)})  vs  mockup ${m.score.toFixed(2)} (func ${m.breakdown.functional.toFixed(2)})  Δ ${gap}`);
      if (!checkOk) console.log(`        !! working build did NOT clear the interaction check — check may be over-tight: ${w.breakdown.notes.join("; ")}`);
      if (m.breakdown.notes.length) console.log(`        mockup: ${m.breakdown.notes.filter((n) => n.includes("functional")).join("; ")}`);
    } finally {
      rmSync(wd, { recursive: true, force: true });
      rmSync(md, { recursive: true, force: true });
    }
  }
  console.log(`\n${failures === 0 ? "ALL PASS — every interaction check is satisfiable by a working build and rejects the mockup." : `${failures} FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
};
main();
