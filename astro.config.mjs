import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  devToolbar: { enabled: false },
  vite: {
    server: {
      proxy: { '/api/aegis': { target: 'http://127.0.0.1:8011' } },
    },
  },
});
