# Supabase reference (curated snippets for a no-build static frontend)

The frontend talks to Supabase directly from the browser with the ESM client and the
project URL + anon (public) key. Row Level Security protects the data, so the anon key is
safe to ship. Edge functions / SQL are files you generate for the user to deploy.

## setup
CRITICAL: your app JS must be a **module** — `import` and top-level `await` only work in
modules. In index.html, load app.js with `type="module"` (NOT a classic `<script>`, which
throws "await is only valid in async functions and the top level bodies of modules").
```html
<!-- index.html -->
<script type="module" src="app.js"></script>
```
```js
// app.js — a module, so import + top-level await are valid here
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
const SUPABASE_ANON_KEY = "YOUR-ANON-KEY"; // public, gated by RLS
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const { data: { session } } = await supabase.auth.getSession(); // top-level await OK in a module
```

## auth
Email/password auth. `signUp` and `signInWithPassword` return `{ data, error }` — always
check `error`. `onAuthStateChange` keeps the UI in sync.
```js
const { data, error } = await supabase.auth.signUp({ email, password });
const { data, error } = await supabase.auth.signInWithPassword({ email, password });
await supabase.auth.signOut();
const { data: { session } } = await supabase.auth.getSession(); // null if logged out
supabase.auth.onAuthStateChange((event, session) => { render(session); });
```

## select
Query rows. Chain filters; `.single()` for one row; always handle `error`.
```js
const { data, error } = await supabase
  .from("tasks")
  .select("id, title, done")
  .eq("user_id", userId)      // filters: .eq .neq .gt .lt .like .in .is
  .order("created_at", { ascending: false })
  .limit(50);
const { data: one } = await supabase.from("tasks").select("*").eq("id", id).single();
```

## insert
Insert one or many; add `.select()` to get the inserted rows back.
```js
const { data, error } = await supabase
  .from("tasks")
  .insert({ title: "Buy milk", user_id: userId })
  .select();
// many: .insert([{ ... }, { ... }])
```

## update
Update matching rows (scope with a filter so you don't update everything).
```js
const { data, error } = await supabase
  .from("tasks")
  .update({ done: true })
  .eq("id", id)
  .select();
```

## delete
Delete matching rows (always filter).
```js
const { error } = await supabase.from("tasks").delete().eq("id", id);
```

## realtime
Subscribe to live DB changes (requires realtime enabled on the table).
```js
const channel = supabase
  .channel("tasks-changes")
  .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, (payload) => {
    console.log(payload.eventType, payload.new, payload.old);
    refresh();
  })
  .subscribe();
// later: supabase.removeChannel(channel);
```

## storage
Upload/download files in a bucket; get a public URL (for a public bucket).
```js
await supabase.storage.from("avatars").upload(`${userId}/photo.png`, file, { upsert: true });
const { data } = supabase.storage.from("avatars").getPublicUrl(`${userId}/photo.png`);
const url = data.publicUrl;
```

## rls
Row Level Security SQL — generate this for the user to run in the Supabase SQL editor.
Enable RLS, then allow each user to see/modify only their own rows.
```sql
alter table tasks enable row level security;

create policy "own rows - select" on tasks for select using (auth.uid() = user_id);
create policy "own rows - insert" on tasks for insert with check (auth.uid() = user_id);
create policy "own rows - modify" on tasks for update using (auth.uid() = user_id);
create policy "own rows - delete" on tasks for delete using (auth.uid() = user_id);
```

## schema
Example table DDL with a user-owned table and timestamps (Supabase SQL editor).
```sql
create table tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) default auth.uid(),
  title text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
```

## edge-function
A Deno edge function (file: `supabase/functions/<name>/index.ts`). Deploy with
`supabase functions deploy <name>`. Call it from the frontend with `functions.invoke`.
```ts
// supabase/functions/hello/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const { name } = await req.json();
  // service-role client (server-side only — env secrets, never in the frontend):
  const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  return new Response(JSON.stringify({ message: `Hello ${name}` }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
```
```js
// frontend call:
const { data, error } = await supabase.functions.invoke("hello", { body: { name: "Ada" } });
```
