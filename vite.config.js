import { defineConfig, loadEnv } from 'vite';

// The CTA API has no CORS headers and the key must never reach the client
// bundle, so the dev server proxies /api/tt and appends the key server-side.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    server: {
      proxy: {
        '/api/tt': {
          target: 'https://lapi.transitchicago.com',
          changeOrigin: true,
          rewrite: (path) =>
            path.replace(/^\/api\/tt/, '/api/1.0/ttpositions.aspx') +
            `&key=${env.CTA_KEY}`,
        },
      },
    },
  };
});
