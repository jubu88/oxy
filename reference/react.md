# React reference — no-build SPA (CDN + in-browser Babel)

Oxy has no bundler, so do NOT write `import`-based JSX files or a Vite/npm project. Instead
load React, ReactDOM and Babel from a CDN and put JSX in a `<script type="text/babel">`. It
compiles in the browser — a real SPA with components, hooks, state and routing, zero build.
(The component/hook/routing patterns transfer 1:1 if a real Vite build is added later.)

## setup
The complete index.html shell. One `<div id="root">`, the three CDN scripts, then your app
in a `text/babel` script. Use React 18 `createRoot`.
```html
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><link rel="stylesheet" href="style.css"></head>
<body>
  <div id="root"></div>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script type="text/babel" src="app.js" data-type="module"></script>
  <!-- app.js must be served as text/babel; or inline the JSX in a <script type="text/babel"> here -->
</body></html>
```
```jsx
// app.js (loaded as text/babel)
const { useState, useEffect, createContext, useContext } = React;
function App() { return <h1>Hello</h1>; }
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
```

## component
Function components return JSX. Compose them; pass data via props.
```jsx
function TaskItem({ task, onToggle }) {
  return (
    <li className={task.done ? "done" : ""} onClick={() => onToggle(task.id)}>
      {task.title}
    </li>
  );
}
```

## state
`useState` for local state. Update with the setter; never mutate state directly.
```jsx
function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount((c) => c + 1)}>Count: {count}</button>;
}
```

## effect
`useEffect` for side effects (fetching, subscriptions, timers). Return a cleanup function;
the dependency array controls when it re-runs (`[]` = once on mount).
```jsx
function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id); // cleanup
  }, []);
  return <p>{now.toLocaleTimeString()}</p>;
}
```

## list
Render arrays with `.map` and a stable, unique `key`.
```jsx
function TaskList({ tasks, onToggle }) {
  return <ul>{tasks.map((t) => <TaskItem key={t.id} task={t} onToggle={onToggle} />)}</ul>;
}
```

## form
Controlled inputs: value from state, update in `onChange`. Prevent default on submit.
```jsx
function AddTask({ onAdd }) {
  const [title, setTitle] = useState("");
  const submit = (e) => { e.preventDefault(); if (title.trim()) { onAdd(title.trim()); setTitle(""); } };
  return (
    <form onSubmit={submit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task" />
      <button type="submit">Add</button>
    </form>
  );
}
```

## routing
No router library — a tiny hash-based router (works without a server or bundler). Each
"page" is a component; links are `<a href="#/path">`.
```jsx
function useHashRoute() {
  const [route, setRoute] = useState(window.location.hash.slice(1) || "/");
  useEffect(() => {
    const on = () => setRoute(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
function App() {
  const route = useHashRoute();
  return (
    <>
      <nav><a href="#/">Home</a> <a href="#/about">About</a></nav>
      {route === "/about" ? <About /> : <Home />}
    </>
  );
}
```

## context
Share state across the tree without prop-drilling: `createContext` + a provider + `useContext`.
```jsx
const AuthContext = createContext(null);
function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  return <AuthContext.Provider value={{ user, setUser }}>{children}</AuthContext.Provider>;
}
function Profile() {
  const { user } = useContext(AuthContext);
  return <p>{user ? user.name : "Guest"}</p>;
}
```
