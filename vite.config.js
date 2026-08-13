import { defineConfig, loadEnv } from 'vite';

// The CTA API has no CORS headers and the key must never reach the client
// bundle, so the dev server proxies /api/tt and appends the key server-side.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    build: {
      rollupOptions: {
        output: {
          // The two rendering stacks are large, stable, and versioned in
          // package.json — splitting them out of the app chunk means a
          // product change ships a small file and leaves ~1.5 MB of vendor
          // code in the browser cache untouched. Without this everything
          // landed in one ~1.76 MB bundle that every deploy invalidated.
          manualChunks: {
            maplibre: ['maplibre-gl'],
            deck: [
              '@deck.gl/core',
              '@deck.gl/layers',
              '@deck.gl/geo-layers',
              '@deck.gl/mapbox',
            ],
          },
        },
      },
    },
    server: {
      proxy: {
        // NOTE: keep this path as exact `/api/tt` only — do NOT name arrivals
        // `/api/ttarrivals` or Vite's prefix match will swallow it into ttpositions.
        '/api/tt': {
          target: 'https://lapi.transitchicago.com',
          changeOrigin: true,
          rewrite: (path) =>
            path.replace(/^\/api\/tt/, '/api/1.0/ttpositions.aspx') +
            `&key=${env.CTA_KEY}`,
        },
        // Station board predictions (ttarrivals) — separate path avoids /api/tt collision.
        '/api/arrivals': {
          target: 'https://lapi.transitchicago.com',
          changeOrigin: true,
          rewrite: (path) =>
            path.replace(/^\/api\/arrivals/, '/api/1.0/ttarrivals.aspx') +
            `&key=${env.CTA_KEY}`,
        },
        // U9: CTA Bus Tracker v3 (a distinct key/host from Train Tracker
        // above). Mirrors /api/tt's rewrite shape exactly. If CTA_BUS_KEY is
        // unset, this interpolates the literal string "undefined" into the
        // upstream URL rather than silently omitting the param — CTA's API
        // answers a bad key with its own auth-error JSON (still HTTP 200),
        // which src/buses.js's isAuthError() detects and turns into a
        // thrown error so the bus feed's status correctly flips to lost
        // instead of claiming LIVE FEED over an empty bus layer.
        '/api/bus': {
          target: 'https://www.ctabustracker.com',
          changeOrigin: true,
          rewrite: (path) =>
            path.replace(/^\/api\/bus/, '/bustime/api/v3') +
            `&key=${env.CTA_BUS_KEY}`,
        },
        // U15: CTA's Customer Alerts API (Route Status + Detailed Alerts) --
        // both keyless per CTA's own developer docs, so no key injection
        // here at all, unlike the two proxies above.
        '/api/alerts': {
          target: 'https://lapi.transitchicago.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/alerts/, '/api/1.0'),
        },
        // Divvy / Lyft GBFS — keyless public feed. Path segments are the
        // allowlisted filenames (station_status.json, station_information.json).
        '/api/divvy': {
          target: 'https://gbfs.lyft.com',
          changeOrigin: true,
          rewrite: (path) =>
            // Dev only. Prod resolves the version prefix from GBFS discovery.
            path.replace(/^\/api\/divvy/, '/gbfs/1.1/chi/en'),
        },
      },
    },
  };
});
