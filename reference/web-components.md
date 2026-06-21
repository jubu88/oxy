# Web Components reference (native, no build step)

Custom elements + shadow DOM run as-is in the browser — no framework, no bundler. Great
for reusable, encapsulated widgets in a plain HTML/JS app.

## define
Define a custom element class and register it. The tag MUST contain a hyphen.
```js
class MyCounter extends HTMLElement {
  connectedCallback() { this.render(); }
  render() { this.innerHTML = `<button>Count: 0</button>`; }
}
customElements.define("my-counter", MyCounter);
```
```html
<my-counter></my-counter>
```

## shadow-dom
Encapsulate markup + styles so outside CSS can't leak in (or out). Build the tree in the
constructor; `:host` styles the element itself.
```js
class MyCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; border: 1px solid #ddd; border-radius: 12px; padding: 16px; }
        h3 { margin: 0 0 8px; }
      </style>
      <h3></h3>
      <slot></slot>`;
  }
  connectedCallback() { this.shadowRoot.querySelector("h3").textContent = this.getAttribute("title") || ""; }
}
customElements.define("my-card", MyCard);
```

## attributes
React to attribute changes with `observedAttributes` + `attributeChangedCallback`.
Mirror important props to attributes so they're reactive.
```js
class StarRating extends HTMLElement {
  static get observedAttributes() { return ["value"]; }
  attributeChangedCallback(name, oldV, newV) { if (oldV !== newV) this.render(); }
  get value() { return Number(this.getAttribute("value") || 0); }
  set value(v) { this.setAttribute("value", v); }
  connectedCallback() { this.render(); }
  render() { this.textContent = "★".repeat(this.value) + "☆".repeat(5 - this.value); }
}
customElements.define("star-rating", StarRating);
```

## lifecycle
The callbacks, in order of usefulness:
- `constructor()` — set up shadow DOM; do NOT read attributes/children here.
- `connectedCallback()` — element added to the DOM; read attributes, render, add listeners.
- `disconnectedCallback()` — removed; remove listeners / timers to avoid leaks.
- `attributeChangedCallback(name, old, new)` — an observed attribute changed.

## events
Communicate UP with a `CustomEvent` (set `bubbles` + `composed` to cross shadow DOM).
```js
this.dispatchEvent(new CustomEvent("change", { detail: { value }, bubbles: true, composed: true }));
```
```js
// parent listens:
document.querySelector("star-rating").addEventListener("change", (e) => console.log(e.detail.value));
```

## slots
Project light-DOM children into the shadow tree. Use named slots for multiple regions.
```html
<my-card title="Hi"><p>Body goes in the default slot</p></my-card>
```
```js
this.shadowRoot.innerHTML = `<header><slot name="head"></slot></header><div><slot></slot></div>`;
```
