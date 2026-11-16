import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';

/** Files in public/ that the shell needs; they are copied after the bundle, so listed by hand. */
const PUBLIC_SHELL = [
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

/** Replaces a placeholder string literal in built code, whatever quotes the minifier chose. */
function inject(code: string, name: string, value: unknown): string {
  const literal = new RegExp(`(["'\`])__${name}__\\1`, 'g');
  if (!literal.test(code)) throw new Error(`sw.js has no __${name}__ placeholder`);
  return code.replace(literal, JSON.stringify(value));
}

/**
 * Builds `src/sw.ts` to `sw.js` at the site root and writes the names of every emitted file into
 * it, so the service worker can precache the hashed bundles of this exact build.
 */
function serviceWorker(): Plugin {
  return {
    name: 'demo-service-worker',
    apply: 'build',
    generateBundle(_, bundle) {
      const worker = Object.values(bundle).find(
        (output) => output.type === 'chunk' && output.fileName === 'sw.js',
      );
      if (worker?.type !== 'chunk') throw new Error('sw.js was not built');
      const files = Object.keys(bundle).filter(
        (fileName) => fileName !== 'sw.js' && !fileName.endsWith('.map'),
      );
      const precache = ['./', ...files, ...PUBLIC_SHELL];
      // Hashed bundle names change with their content, so the list identifies this build.
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);
      worker.code = inject(worker.code, 'PRECACHE_MANIFEST', precache);
      // The version is inlined into a string, so it replaces the bare token.
      if (!worker.code.includes('__SHELL_VERSION__')) throw new Error('sw.js has no version token');
      worker.code = worker.code.replaceAll('__SHELL_VERSION__', version);
    },
  };
}

export default defineConfig({
  // Relative URLs, so the build also works below a sub-path such as GitHub Pages (#20).
  base: './',
  plugins: [serviceWorker()],
  build: {
    sourcemap: true,
    rolldownOptions: {
      input: { main: 'index.html', sw: 'src/sw.ts' },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  preview: { port: 4174, strictPort: true },
});
