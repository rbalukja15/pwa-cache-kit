# Releasing

Versions and the changelog come from changesets (see CLAUDE.md). Publishing is done by the
[Release workflow](../.github/workflows/release.yml), which runs when a version tag is pushed.

## One-time setup

1. Create an npm access token that can publish `@rbalukja/pwa-cache-kit`: on npmjs.com, Access
   Tokens, Generate New Token, a granular token with read and write access to the package (or to
   the `@rbalukja` scope before the first publish).
2. Add it to the repository as the Actions secret `NPM_TOKEN` (Settings, Secrets and variables,
   Actions).

Provenance needs no setup: the workflow has `id-token: write`, and the repository is public.

## Cutting a release

1. On an up-to-date `main`, apply the pending changesets:

   ```sh
   npm run version-packages
   ```

   This bumps `packages/pwa-cache-kit/package.json`, writes `packages/pwa-cache-kit/CHANGELOG.md`
   and removes the applied changesets. Review the result.

2. Merge that change into `main` through a pull request (`chore(release): 0.1.0`).
3. Tag the merge commit with the new version and push the tag:

   ```sh
   git checkout main && git pull
   git tag v0.1.0
   git push origin v0.1.0
   ```

The workflow checks that the tag matches the package version and points at a commit on `main`,
runs the CI checks and the pack smoke test, then runs `npm publish --provenance`. A failed run
publishes nothing; fix the cause and push the tag again after deleting it
(`git push origin :refs/tags/v0.1.0`), or release the fix as the next patch.

## Checking a release

- The package page on npmjs.com shows the new version with a provenance badge that links to the
  workflow run.
- In an empty project, `npm install @rbalukja/pwa-cache-kit` and import both
  `@rbalukja/pwa-cache-kit` and `@rbalukja/pwa-cache-kit/inspector`. `npm run test:pack` does the
  same with a local tarball before every publish.
