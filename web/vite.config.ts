import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * public/config.json is a local-dev file. Keep it out of dist/ so a build never
 * ships one environment's settings; CDK writes the real config.json on deploy.
 */
function dropLocalConfig(): Plugin {
  let outDir = 'dist'
  return {
    name: 'cloudattend-drop-local-config',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      rmSync(resolve(outDir, 'config.json'), { force: true })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), dropLocalConfig()],
  // Absolute asset paths: CloudFront serves the app at the domain root and answers deep
  // links (e.g. /classes/CS101/report) with index.html, so relative paths like
  // ./assets/x.js would resolve under /classes/CS101/ and break on refresh.
  base: '/',
  server: {
    // The photo bucket's CORS rule allows PUT from http://localhost:5173 only,
    // so fail loudly instead of silently moving to another port.
    port: 5173,
    strictPort: true,
  },
})
