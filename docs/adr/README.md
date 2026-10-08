# Architecture decision records

Significant design decisions for `@rbalukja/pwa-cache-kit` are recorded here, one file per decision,
named `NNNN-short-title.md`.

| ADR                                       | Title                                                 | Status   | Date       |
| ----------------------------------------- | ----------------------------------------------------- | -------- | ---------- |
| [0001](./0001-three-tier-cache.md)        | Three cache tiers (memory, SessionStorage, IndexedDB) | Accepted | 2026-10-07 |
| [0002](./0002-cache-api-and-semantics.md) | Cache API and cross-tier semantics                    | Accepted | 2026-10-07 |

## Process

1. Copy [`0000-template.md`](./0000-template.md) to `NNNN-short-title.md`, using the next free
   number.
2. Fill in every section and set the status to Proposed.
3. Open a pull request that adds the ADR and its row in the table above. Once it is approved, change
   the status to Accepted in both places as the last commit before merging.
