// Claude (acting as the supervisor / "improvement model") reviewing the 7 batch builds
// from skillopt/batch-results.json. Each review is a real assessment of that build's
// CODE — not a model-generated guess — appended to the journal so the promote can fold
// the recurring failures into a skill edit. Run once: node skillopt/journal-batch.mjs
import { appendJournal, unconsumedCount, readJournal } from "./supervisor.ts";

const base = Date.now();
const reviews = [
  {
    id: "clock",
    project: "batch-clock-2606191213",
    finished: true,
    wins: ["design_system first, then wrote files and verified with check_app before done", "concise — 6 tool calls, no wasted passes"],
    mistakes: [],
    lesson: "",
  },
  {
    id: "tip",
    project: "batch-tip-2606191215",
    finished: false,
    wins: ["fetched a design system first", "wired the tip buttons and the calculate handler"],
    mistakes: [
      "entered a check_app -> edit_file loop (5 cycles) and never converged",
      "hit the iteration cap WITHOUT calling done — shipped no finished result",
      "tip buttons write a decimal (0.10) into a field labelled 'Custom %', a confusing internal contract",
    ],
    lesson: "After check_app, make AT MOST ONE edit_file fix and then call done. Never loop check_app->edit_file repeatedly — a finished imperfect app is far better than burning every turn and never calling done.",
  },
  {
    id: "temp",
    project: "batch-temp-2606191223",
    finished: true,
    wins: ["live input listeners on every field", "finished and verified"],
    mistakes: [
      "the converter reads ALL fields and runs every formula in sequence, so the values overwrite each other and it never isolates the field the user actually edited",
      "passes a quick check but produces wrong numbers on the second edit",
    ],
    lesson: "For multi-field reactive forms (unit converters, linked inputs), convert FROM the single field the user just changed (use the event target) — never recompute from all fields at once, or stale values clobber the result.",
  },
  {
    id: "pomodoro",
    project: "batch-pomodoro-2606191226",
    finished: true,
    wins: ["clean timer state machine — start/pause/reset, work/break switch, session counter", "managed button disabled states", "finished and verified"],
    mistakes: ["used a blocking alert() for the session-end notice"],
    lesson: "Prefer updating an on-page element over blocking alert()/confirm() dialogs — alerts freeze the page and don't appear in a preview screenshot, so they also can't be verified.",
  },
  {
    id: "memory",
    project: "batch-memory-2606191229",
    finished: true,
    wins: ["solid game logic — shuffle, flip, match, lockBoard, win overlay", "good use of a warm design system", "finished and verified"],
    mistakes: [
      "called generate_image to create card_back.png but the CSS never references it — a slow image generation wasted",
      "tracks a moves count in JS but there is no element in the HTML to display it",
    ],
    lesson: "Do NOT call generate_image unless the file will actually be referenced by the page (an <img> or CSS url()) — it is slow, so only generate images you wire in. Likewise every value you compute (score, moves) needs a DOM element to show it.",
  },
  {
    id: "todo",
    project: "batch-todo-2606191234",
    finished: true,
    wins: ["localStorage persistence (load/save)", "All/Active/Completed filtering works", "add/toggle/delete all wired", "finished and verified"],
    mistakes: ["adds the 'completed' class to the <li>, but the CSS targets '.task-content.completed', so completed items never get the line-through style — the JS class target and the CSS selector disagree"],
    lesson: "Keep CSS selectors in sync with the classes and elements the JS actually creates — if the JS adds a class to element X, the matching CSS rule must target X, not a child of X.",
  },
  {
    id: "t2048",
    project: "batch-t2048-2606191242",
    finished: false,
    wins: ["set up the board model and tile rendering"],
    mistakes: [
      "JS looks up '.game-over-message', which does NOT exist in the HTML, so initializeGame() throws a null-reference error on load and the game never starts",
      "HTML and JS drifted apart (it also shows a 'Lines' counter copied from Tetris, not 2048)",
      "entered a check_app -> edit_file loop (5 cycles) and hit the iteration cap without calling done",
    ],
    lesson: "Before finishing, ensure EVERY element the JS looks up (getElementById / querySelector) actually exists in the HTML — a single missing element throws a null-reference error that breaks the whole script. Author the HTML and JS together so their ids/classes match.",
  },
];

let n = 0;
for (const r of reviews) {
  appendJournal({
    ts: base + n * 1000,
    task: `build the ${r.id} app`,
    project: r.project,
    finished: r.finished,
    wins: r.wins,
    mistakes: r.mistakes,
    lesson: r.lesson,
  });
  n++;
}
console.log(`[journal-batch] appended ${n} reviews · journal now has ${readJournal().length} entries, ${unconsumedCount()} unconsumed`);
