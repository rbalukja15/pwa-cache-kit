// Styles of the inspector panel, scoped by its shadow root.
export const STYLES = `
:host {
  --ck-bg: #ffffff;
  --ck-fg: #1d2433;
  --ck-muted: #5b6474;
  --ck-line: #d9dde5;
  --ck-head: #1f2937;
  --ck-memory: #2563eb;
  --ck-session: #7c3aed;
  --ck-indexeddb: #0f766e;
  --ck-hit: #15803d;
  --ck-miss: #6b7280;
  --ck-evict: #c2410c;
  --ck-evict-bg: #ffedd5;
  --ck-error: #b91c1c;
  all: initial;
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 2147483000;
  width: min(34rem, calc(100vw - 2rem));
  font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--ck-fg);
}
@media (prefers-color-scheme: dark) {
  :host {
    --ck-bg: #161b26;
    --ck-fg: #e5e7eb;
    --ck-muted: #9ca3af;
    --ck-line: #2d3546;
    --ck-head: #0b0f17;
    --ck-memory: #60a5fa;
    --ck-session: #a78bfa;
    --ck-indexeddb: #2dd4bf;
    --ck-hit: #4ade80;
    --ck-miss: #9ca3af;
    --ck-evict: #fb923c;
    --ck-evict-bg: #431407;
    --ck-error: #f87171;
  }
}
@media (max-width: 30rem) {
  :host { right: 0.5rem; bottom: 0.5rem; width: calc(100vw - 1rem); }
}
* { box-sizing: border-box; }
.panel {
  display: flex;
  flex-direction: column;
  max-height: min(70vh, 40rem);
  overflow: hidden;
  border: 1px solid var(--ck-line);
  border-radius: 10px;
  background: var(--ck-bg);
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.25);
}
header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--ck-head);
  color: #f9fafb;
}
header h2 { margin: 0 auto 0 0; font-size: 13px; font-weight: 600; }
button {
  font: inherit;
  color: inherit;
  cursor: pointer;
  padding: 0.125rem 0.5rem;
  border: 1px solid rgb(255 255 255 / 0.3);
  border-radius: 6px;
  background: transparent;
}
.status { display: flex; gap: 0.25rem; }
.body { overflow: auto; padding: 0.5rem 0.75rem 0.75rem; }
.panel.collapsed .body { display: none; }
h3 {
  margin: 0.5rem 0 0.25rem;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ck-muted);
}
table { width: 100%; border-collapse: collapse; }
th, td {
  padding: 0.25rem 0.375rem;
  border-bottom: 1px solid var(--ck-line);
  text-align: left;
  vertical-align: top;
}
th { font-weight: 600; color: var(--ck-muted); }
td.key { word-break: break-all; }
.empty { color: var(--ck-muted); font-style: italic; }
.tier {
  display: inline-block;
  margin: 0 0.25rem 0.125rem 0;
  padding: 0 0.375rem;
  border-radius: 999px;
  border: 1px solid currentColor;
  font-size: 11px;
  white-space: nowrap;
}
.tier.memory { color: var(--ck-memory); }
.tier.session { color: var(--ck-session); }
.tier.indexeddb { color: var(--ck-indexeddb); }
.tier.unavailable { opacity: 0.5; text-decoration: line-through; }
header .tier { color: #f9fafb; }
.tier.evicted { color: var(--ck-evict); background: var(--ck-evict-bg); text-decoration: line-through; }
tr.evicted td { background: var(--ck-evict-bg); }
ol.log { margin: 0; padding: 0; list-style: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
ol.log li { display: flex; gap: 0.5rem; padding: 0.125rem 0; border-bottom: 1px solid var(--ck-line); }
ol.log time { color: var(--ck-muted); flex: none; }
ol.log .type { flex: none; width: 4.5rem; font-weight: 600; }
.type.hit { color: var(--ck-hit); }
.type.miss { color: var(--ck-miss); }
.type.evict, .type.expire { color: var(--ck-evict); }
.type.error { color: var(--ck-error); }
li.evict { background: var(--ck-evict-bg); }
`;
