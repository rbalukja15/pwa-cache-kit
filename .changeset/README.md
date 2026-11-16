# Changesets

Every user-facing change to `@rbalukja/pwa-cache-kit` ships with a changeset: a short Markdown file
in this folder that names the version bump and the line for the changelog. Add one with:

```sh
npx changeset
```

Pick the bump by the project's pre-1.0 rules (see `CLAUDE.md`):

- `minor` for a breaking change (`0.x` to `0.(x+1)`).
- `patch` for a non-breaking feature or fix.
- Never `major` before 1.0: it would publish 1.0.0.

Docs, tests, CI and tooling changes that do not change the published package need no changeset.

`npm run version-packages` consumes the pending changesets, bumps `version` in the package's
`package.json` and writes `packages/pwa-cache-kit/CHANGELOG.md`. Never edit either by hand.
