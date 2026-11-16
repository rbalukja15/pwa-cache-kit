# Releasing

Versions and the changelog come from changesets (see CLAUDE.md). Publishing is done by the
[Release workflow](../.github/workflows/release.yml), which runs when a version tag is pushed.

## One-time setup

1. Create an npm access token that can publish `@rbalukja/pwa-cache-kit`: on npmjs.com, Access
   Tokens, Generate New Token, a granular token with read and write access to the `@rbalukja`
   scope (the package does not exist yet before the first publish). Give it a short expiry: it is
   only needed for the first release.
2. Add it to the repository as the Actions secret `NPM_TOKEN` (Settings, Secrets and variables,
   Actions).
3. Optional but recommended: in Settings, Environments, open `npm` (created by the first run, or
   create it by hand) and add yourself as a required reviewer, so that every publish waits for
   your approval in the Actions tab.

Provenance needs no setup: the workflow has `id-token: write`, the repository is public, and the
package's `publishConfig` turns it on.

## After the first release: trusted publishing

npm can authenticate the workflow by its GitHub identity instead of a stored token, which leaves no
long-lived secret to leak. It can only be set up once the package exists on npm:

1. On npmjs.com, open the package's Settings, Trusted Publisher, choose GitHub Actions and enter
   owner `rbalukja15`, repository `pwa-cache-kit`, workflow `release.yml` and environment `npm`.
2. Delete the `NPM_TOKEN` secret from the repository and revoke the token on npmjs.com.

The workflow needs no change: npm uses the trusted publisher when one is configured, and the
`NODE_AUTH_TOKEN` line then has nothing to pass.

## Cutting a release

1. On an up-to-date `main`, apply the pending changesets:

   ```sh
   npm run version-packages
   ```

   This bumps `packages/pwa-cache-kit/package.json`, writes `packages/pwa-cache-kit/CHANGELOG.md`
   and removes the applied changesets. Review the result.

2. Merge that change into `main` through a pull request (`chore(release): 0.1.0`).
3. Optional dry run: in Actions, Release, Run workflow on `main`. It runs every step, including
   the version and main-branch check, and ends with `npm publish --dry-run`, which lists what would
   be uploaded and publishes nothing.
4. Tag the merge commit with the new version and push the tag:

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
