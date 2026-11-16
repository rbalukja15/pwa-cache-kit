// Packs the library the way `npm publish` would, installs the tarball into an empty project and
// checks that both entry points import, work and type-check from the installed package. Run it
// after a build: `npm run test:pack` does both.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageDir, '../..');
const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const required = [
  'LICENSE',
  'README.md',
  'package.json',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/inspector.js',
  'dist/inspector.d.ts',
];
const forbidden = /^(src|test|e2e|scripts)\//;

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function fail(message: string): never {
  console.error(`pack smoke test: ${message}`);
  process.exit(1);
}

interface PackResult {
  filename: string;
  files: { path: string }[];
}

const work = mkdtempSync(join(tmpdir(), 'pwa-cache-kit-pack-'));
try {
  const [pack] = JSON.parse(
    run(npm, ['pack', '--json', '--pack-destination', work], packageDir),
  ) as PackResult[];
  if (pack === undefined) fail('npm pack returned no tarball');

  const files = pack.files.map((file) => file.path);
  const missing = required.filter((path) => !files.includes(path));
  if (missing.length > 0) fail(`tarball is missing ${missing.join(', ')}`);
  const extra = files.filter((path) => forbidden.test(path));
  if (extra.length > 0) fail(`tarball must not contain ${extra.join(', ')}`);

  const consumer = join(work, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
  );
  run(
    npm,
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', join(work, pack.filename)],
    consumer,
  );

  // Runtime: both entries resolve through the package's exports map. Outside a browser the cache
  // is inert (ADR-0002 section 13), so a write stores nothing and reports no error; the
  // browser behavior of the built files is covered by the Playwright tests.
  writeFileSync(
    join(consumer, 'smoke.mjs'),
    `import { createCache, memoryTier } from '@rbalukja/pwa-cache-kit';
import { createInspector } from '@rbalukja/pwa-cache-kit/inspector';

if (typeof createInspector !== 'function') throw new Error('createInspector is not exported');
const cache = createCache({ name: 'smoke', tiers: [memoryTier()] });
const items = cache.namespace('items', { tiers: ['memory'] });
const result = await items.set('a', 1);
if (result.stored.length !== 0 || result.errors.length !== 0) {
  throw new Error('an inert cache stored a value: ' + JSON.stringify(result));
}
cache.close();
`,
  );
  run(process.execPath, ['smoke.mjs'], consumer);

  // Types: a consumer with strict settings type-checks against the shipped .d.ts files.
  writeFileSync(
    join(consumer, 'smoke.ts'),
    `import { createCache, memoryTier, type CacheEvent } from '@rbalukja/pwa-cache-kit';
import { createInspector } from '@rbalukja/pwa-cache-kit/inspector';

const cache = createCache({ name: 'smoke', tiers: [memoryTier()] });
const items = cache.namespace<{ n: number }>('items', { tiers: ['memory'] });
export const value: Promise<{ n: number } | undefined> = items.get('a');
export const log: CacheEvent[] = [];
cache.on('set', (event) => log.push(event));
createInspector().attach(cache);
`,
  );
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2022', 'DOM'],
        strict: true,
        noEmit: true,
        types: [],
      },
      files: ['smoke.ts'],
    }),
  );
  run(process.execPath, [tsc, '-p', 'tsconfig.json'], consumer);

  console.log(`pack smoke test passed: ${pack.filename} (${String(files.length)} files)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
