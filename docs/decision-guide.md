# Decision guide

Status: outline. The content is finalized in issue #18, using the benchmark numbers from issue #17.

How to choose a tier policy for each kind of data. This is the only decision guide in the
repository; other documents link here instead of repeating it. The reasoning behind the three tiers
is in [ADR-0001](./adr/0001-three-tier-cache.md).

## Which tier for which data

A table mapping common kinds of data (derived UI state, form drafts, API responses, user content,
large binary values) to a recommended tier policy, with the reason for each.

## Quick decision flow

A short list of questions leading to a policy: must the value survive a reload, a closed tab or a
browser restart? Must other tabs or the service worker see it? How large is it, and is it
JSON-safe?

## Tier policies in practice

The common policies (memory only, memory and SessionStorage, memory and IndexedDB, all three) and
when each one is the right default.

## Cost of each tier

Read and write latency per tier and value size (p50 and p95), taken from
[`docs/benchmarks.md`](./benchmarks.md), and when the cost of a slower tier matters.

## Per-browser quota and eviction notes

Storage limits and eviction behavior in Chromium, Firefox and Safari, including Safari's handling
of script-writable storage, installed web apps, private browsing modes, and how to check usage with
`navigator.storage.estimate()`.

## Service workers, SSR and missing tiers

Which tiers exist in each environment, and how a policy behaves when one of its tiers is missing,
as defined in ADR-0002 (issue #6).

## Common mistakes

Patterns to avoid, such as large values in SessionStorage, values that are not JSON-safe in
SessionStorage, or per-tab state in IndexedDB.
