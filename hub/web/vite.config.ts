import path from 'path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

/**
 * The hub serves the panel with `style-src 'self'` (no inline <style> elements). A few
 * dependencies inject <style> tags at runtime; strip those injections at build time and ship the
 * equivalent rules in our own stylesheet (see src/styles/index.css, "CSP-safe vendor styles").
 */
function cspSafeStyles(): Plugin {
  const radixStyleEl =
    /jsx\(\s*"style",\s*\{\s*dangerouslySetInnerHTML:\s*\{\s*__html:\s*`[^`]*`\s*\},\s*nonce\s*\}\s*\)/g
  return {
    name: 'ekip-csp-safe-styles',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]
      // sonner: injects its whole stylesheet via __insertCSS(); we import sonner/dist/styles.css.
      if (/[\\/]sonner[\\/]dist[\\/]index\.m?js$/.test(file)) {
        const out = code.replace(
          /function __insertCSS\(code\) \{/,
          'function __insertCSS(code) { return;'
        )
        if (out === code) this.error('sonner: __insertCSS not found')
        return out
      }
      // react-style-singleton (react-remove-scroll): scroll-lock <style>. index.css overrides
      // body[data-scroll-locked] anyway, so dropping it changes nothing visible.
      if (/react-style-singleton[\\/]dist[\\/].*singleton\.js$/.test(file)) {
        const out = code.replace(
          /if \(\(stylesheet = makeStyleTag\(\)\)\)/,
          'if ((stylesheet = null))'
        )
        if (out === code) this.error('react-style-singleton: makeStyleTag not found')
        return out
      }
      // Radix Select / ScrollArea viewports render an inline <style> that hides scrollbars.
      if (/@radix-ui[\\/]react-(select|scroll-area)[\\/]dist[\\/]index\.mjs$/.test(file)) {
        const out = code.replace(radixStyleEl, 'null')
        if (out === code) this.error(`${file}: inline <style> not found`)
        return out
      }
      return null
    },
  }
}

const hub = process.env.EKIP_HUB_DEV_URL ?? 'http://127.0.0.1:7799'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    cspSafeStyles(),
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    // Served by hub/src/server.js: /assets/* long-cached, index.html no-cache, SPA fallback.
    outDir: '../public',
    emptyOutDir: true,
    // Never inline assets as data: URIs (fonts must come from 'self').
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  optimizeDeps: {
    // Pre-bundled deps skip plugin transforms; keep the patched ones out so dev matches prod.
    exclude: ['sonner'],
  },
  server: {
    proxy: {
      '/api': hub,
      '/logout': hub,
      '/login': {
        target: hub,
        bypass: (req) => (req.method === 'POST' ? undefined : '/index.html'),
      },
    },
  },
})
