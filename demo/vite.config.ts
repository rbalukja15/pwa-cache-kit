import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { serviceWorker } from './build/service-worker.js';

export default defineConfig({
  // Relative URLs, so the build also works below a sub-path such as GitHub Pages (#20).
  base: './',
  plugins: [serviceWorker(fileURLToPath(new URL('public', import.meta.url)))],
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
