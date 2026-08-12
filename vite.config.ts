import { defineConfig, type Plugin } from 'vite'

/**
 * Vite stamps `crossorigin` on the emitted <script> and <link rel=stylesheet>.
 * Every asset here is same-origin, so it buys nothing — but it does make the
 * browser send an `Origin` header, and some static hosts (Cloudflare Pages
 * among them) answer that CORS variant with the SPA fallback HTML instead of
 * the file. The stylesheet is then refused for having a `text/html` MIME type
 * and the whole site renders unstyled, while curl (no Origin) sees a perfectly
 * good text/css. Dropping the attribute keeps the request simple.
 */
function noCrossorigin(): Plugin {
  return {
    name: 'no-crossorigin-on-same-origin-assets',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(=("|')[^"']*\2)?/g, '')
    },
  }
}

export default defineConfig({
  plugins: [noCrossorigin()],
  /**
   * GitHub Pages serves a project site from `/<repo>/`, not from the domain
   * root, and every asset URL has to agree — get this wrong and the page loads
   * to a blank screen with four 404s. The deploy workflow works the path out
   * from the repository name and passes it in, so nothing is hard-coded here
   * and `npm run dev` still runs at `/`.
   */
  base: process.env.BASE_PATH || '/',
  server: { port: 5180, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
})
