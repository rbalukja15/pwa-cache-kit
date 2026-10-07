# CLAUDE.md

Context and rules for Claude Code when working in this repository.

## Project

`@rbalukja/pwa-cache-kit` is an offline-first cache library for Progressive Web Apps. Values live
in three tiers, checked from fastest to most durable:

1. **Memory**: in-process (one document or worker), lost on reload.
2. **SessionStorage**: one origin in one tab, window contexts only (absent in workers and service
   workers), survives reloads, synchronous, string-only, small quota (about 5 MB).
3. **IndexedDB**: shared by an origin's tabs and workers, asynchronous, structured-clone values.
   Survives reloads and restarts on a best-effort basis only: the browser may evict it (storage
   pressure, Safari's 7-day cap), and private browsing discards it.

ADR-0001 (#3) records why there are three tiers. Cross-tier semantics (read fall-through,
promotion, write policy, expiry, eviction, error handling) are defined in ADR-0002
(`docs/adr/0002-*.md`, issue #6), which is the source of truth. If code and ADR disagree, raise it
instead of guessing. If a task needs cross-tier semantics and ADR-0002 is not merged yet, stop and
report; do not invent them.

The library is TypeScript, ESM only, built with tsup, and has no runtime dependencies.

## Repository layout

```
packages/pwa-cache-kit/   the library (npm workspace, published as @rbalukja/pwa-cache-kit)
  src/index.ts            single public entry point: everything exported here is public API
  src/                    implementation only, no tests
  test/                   unit tests mirroring src/: src/a/b.ts -> test/a/b.test.ts
  test/conformance/       shared TierAdapter conformance suite (#22)
  tsup.config.ts          build config: ESM + .d.ts into dist/
docs/adr/                 architecture decision records, NNNN-short-title.md (planned, #3)
demo/                     demo app workspace (planned, #15)
```

Entries marked planned, and `test/`, do not exist until the issue that adds them is merged.

Shared config sits at the root: `tsconfig.base.json` (compiler options), `tsconfig.json`
(typecheck scope), `eslint.config.js`, `vitest.config.ts`, `.prettierrc.json`.

## Commands

Node 24 (`.nvmrc`), engines `>=22.22.1`. `npm install` also installs the pre-commit hook.

```sh
npm run build          # tsup: ESM + .d.ts into packages/pwa-cache-kit/dist
npm run dev            # tsup --watch for the library
npm test               # vitest run (passes when there are no tests)
npm run test:watch     # vitest in watch mode
npm run test:coverage  # vitest with coverage thresholds, as CI runs it (added by #4)
npm run lint           # eslint . (type-aware: strictTypeChecked + stylisticTypeChecked)
npm run typecheck      # tsc -p tsconfig.json (noEmit; src, test and config files)
npm run format:check   # prettier --check .
```

Single file or test: `npx vitest run packages/pwa-cache-kit/test/<file>.test.ts` or
`npx vitest run -t "<test name>"`.

The pre-commit hook (simple-git-hooks + lint-staged) runs `eslint --fix` and `prettier --write` on
staged files. To format by hand, run `npx prettier --write <paths>` on the files you changed. Avoid
`npm run format` (whole repo) so diffs stay within the issue's scope.

## Code conventions

- TypeScript `strict` plus `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature` and
  `verbatimModuleSyntax` (use `import type` for type-only imports).
- No `any`, explicit or through casts. Use `unknown` and narrow, or generics. No `@ts-ignore`, and
  do not disable lint rules to get a green build.
- Prettier: single quotes, trailing commas, print width 100. Two-space indent, LF line endings.
- ESM only and `sideEffects: false`: no top-level side effects, and no access to `sessionStorage`
  or `indexedDB` at import time.
- Keep the core bundle small: prefer platform APIs, keep exports tree-shakeable, and check the size
  of `dist/index.js` after `npm run build` when adding to the core path.
- No new runtime dependencies without an ADR in `docs/adr`. Dev dependencies are fine.
- Tests ship with the feature in the same PR. Bug fixes come with a regression test.
- Public API changes (exports of `src/index.ts`, their types, events, or observable cross-tier
  behavior) update ADR-0002 in the same PR.

## Design constraints

- Every tier implements the shared `TierAdapter` interface (#22) and must pass the shared
  conformance suite in `test/conformance/`. Tier-agnostic behavior is tested in the suite, not in
  per-tier tests. Change the interface and the suite together, then make every adapter pass.
- No tier may diverge from the cross-tier semantics in ADR-0002 (#6).
- The events API (#23) is the only way the inspector reads internals. Do not add debug getters,
  internal exports or other back doors for it. If the inspector needs more data, extend the events
  (a public API change, so ADR-0002 is updated too).

## Tooling notes

- TypeScript is pinned to `~6.0` because typescript-eslint does not support 7.x yet. Do not bump
  it. The tsup dts build sets `ignoreDeprecations: '6.0'` because tsup passes `baseUrl`.
- `npm run typecheck` covers only the root `tsconfig.json` `include` (`packages/*/src`,
  `packages/*/test`, `packages/*/*.config.ts`, `*.config.ts`), and type-aware lint fails on TS files
  that no tsconfig includes. Add new TS locations such as `demo/` to that `include`. A separate
  tsconfig makes lint pass but is not typechecked unless it is also wired into `npm run typecheck`
  (e.g. `tsc -b` with project references).
- vitest only runs `packages/*/{src,test}/**/*.test.ts`. Update `vitest.config.ts` for other paths.
- `.js` files get browser plus Node globals and have type-aware rules off, but are still parsed
  through the project service, which only accepts root-level `.js` files
  (`allowDefaultProject: ['*.js']`). A `.js` file in a subfolder (e.g. a demo service worker) fails
  lint until `eslint.config.js` is extended to cover it.

## Commits, PRs and releases

- Conventional Commits: `type(scope): imperative subject`, e.g. `feat(memory): add tier adapter`.
  Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`. Mark breaking
  changes with `!` or a `BREAKING CHANGE:` footer. The body explains why.
- One issue per PR, on a branch named `<type>/<issue>-<slug>` (e.g. `chore/1-scaffold`). The PR
  body contains `Closes #<n>`; the commit footer may carry it too.
- Semver, pre-1.0: breaking changes bump the minor version (`0.x` to `0.(x+1)`). Non-breaking
  features and fixes bump the patch, since `^0.x.y` ranges with x >= 1 only accept patch updates.
  The first public release is 0.1.0, because `^0.0.y` accepts no updates at all.
- Changesets (#19) drive versions and the changelog. Once they land, every user-facing library
  change includes a changeset (`npx changeset`) with that bump, and `version` is never edited by
  hand. Before 1.0, never pick `major` in a changeset: it would publish 1.0.0.
- No AI attribution in commits, PRs, issues or code: no `Co-Authored-By` trailers, no "Generated
  with" footers, no AI session links.

## Per-issue workflow

1. Read the issue (`gh issue view <n>`), including its "Depends on" section and acceptance criteria.
2. Confirm every dependency is merged into `main`. If one is not, stop and report it.
3. Branch from an up-to-date `main`.
4. Implement with tests, staying within the issue's scope. Update ADR-0002 for public API changes;
   write an ADR for any new runtime dependency.
5. Run the CI checks locally, all must pass:
   `npm run format:check && npm run lint && npm run typecheck && npm run build`, then
   `npm run test:coverage` (CI enforces its coverage thresholds; use `npm test` until #4 lands).
6. Open a PR using the PR template, with a Conventional Commits title and `Closes #<n>` in the body.
7. The issue's acceptance criteria are the definition of done. Check each one before review.
