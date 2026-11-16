// Build step of the demo's service worker (src/sw.ts): writes this build's precache list and a
// version that changes whenever any precached file changes into the built sw.js.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/** Files in public/ that the shell needs; Vite copies them after the bundle, so listed by hand. */
export const PUBLIC_SHELL: readonly string[] = [
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

export interface ShellFile {
  readonly fileName: string;
  readonly content: string | Uint8Array;
}

/**
 * A version of the shell that changes when any file's name or content changes, so that an edit to
 * a file with a fixed name (index.html, the manifest, an icon) still yields a new sw.js, which is
 * what makes browsers install the update.
 */
export function shellVersion(files: readonly ShellFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    hash.update(file.fileName).update('\0').update(file.content).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/** Writes the precache list and the version into the built worker's placeholders. */
export function writeServiceWorker(code: string, precache: readonly string[], version: string) {
  // The list replaces a string literal, whatever quotes the minifier chose.
  const literal = /(["'`])__PRECACHE_MANIFEST__\1/g;
  if (!literal.test(code)) throw new Error('sw.js has no __PRECACHE_MANIFEST__ placeholder');
  if (!code.includes('__SHELL_VERSION__')) throw new Error('sw.js has no __SHELL_VERSION__ token');
  // The version is inlined into a string, so it replaces the bare token.
  return code.replace(literal, JSON.stringify(precache)).replaceAll('__SHELL_VERSION__', version);
}

/**
 * Builds `src/sw.ts` to `sw.js` at the site root (see the input in vite.config.ts) and fills in
 * its precache list and version. Runs after Vite's own plugins, so index.html is in the bundle.
 */
export function serviceWorker(publicDir: string): Plugin {
  return {
    name: 'demo-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const worker = bundle['sw.js'];
      if (worker?.type !== 'chunk') throw new Error('sw.js was not built');
      const files: ShellFile[] = Object.values(bundle)
        .filter((output) => output.fileName !== 'sw.js' && !output.fileName.endsWith('.map'))
        .map((output) => ({
          fileName: output.fileName,
          content: output.type === 'asset' ? output.source : output.code,
        }));
      if (!files.some((file) => file.fileName === 'index.html')) {
        throw new Error('index.html is not in the bundle yet');
      }
      for (const fileName of PUBLIC_SHELL) {
        files.push({ fileName, content: readFileSync(join(publicDir, fileName)) });
      }
      // The shell is precached as './', the URL navigations are answered with.
      const precache = files.map(({ fileName }) => (fileName === 'index.html' ? './' : fileName));
      worker.code = writeServiceWorker(worker.code, precache, shellVersion(files));
    },
  };
}
