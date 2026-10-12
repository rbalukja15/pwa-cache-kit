# Benchmarks

Status: placeholder. No results have been recorded yet.

Issue #17 adds the benchmark suite and records both the method and the results on this page. The
plan:

- Run in real browsers (Chromium, Firefox and WebKit) driven by Playwright.
- Measure reads and writes per tier across several value sizes and report p50 and p95 latencies.
- Record the browser versions, machine and settings next to each set of results so they can be
  reproduced.

Numbers measured against `fake-indexeddb` or any other in-memory stand-in are never published here.
Those stand-ins are for unit tests in Node and say nothing about the cost of IndexedDB in a browser.

The [decision guide](./decision-guide.md) uses these results once they exist.
