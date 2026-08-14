import { defineConfig } from 'vite';

export default defineConfig({
  // Relative assets make the same build work at / and at /<repo>/ on GitHub Pages.
  base: './',
  server: { host: 'localhost', port: 5173, strictPort: true },
  preview: { host: 'localhost', port: 4173, strictPort: true },
  worker: { format: 'es' },
});
