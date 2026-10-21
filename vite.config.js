import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const STANDARD_CHUNK_BUDGET = 600_000;
const PLOTLY_CHUNK_BUDGET = 2_800_000;

function enforceChunkBudgets() {
  return {
    name: 'enforce-chunk-budgets',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        const mapModule = Object.keys(output.modules).find(id =>
          /node_modules[\\/](?:maplibre-gl|@plotly[\\/]mapbox-gl)[\\/]/.test(id)
          && !id.endsWith('.css')
        );
        if (mapModule) this.error(`Geographic map code must not enter the scientific chart bundle: ${mapModule}`);
        const isLazyPlotlyRenderer = output.name === 'PlotlyRenderer';
        const budget = isLazyPlotlyRenderer ? PLOTLY_CHUNK_BUDGET : STANDARD_CHUNK_BUDGET;
        if (output.code.length > budget) {
          this.error(
            `${output.fileName} is ${output.code.length} bytes; budget is ${budget} bytes.`
          );
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), enforceChunkBudgets()],
  resolve: { alias: { buffer: 'buffer/' } },
  define: { global: 'globalThis' },
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    },
    watch: {
      ignored: ['**/r-backend/**']
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Keep the editor libraries independently cacheable as notebook tools
        // grow. This dependency is loaded with the lazy document workspace.
        manualChunks(id) {
          if (/node_modules[\\/](?:@codemirror|@lezer|style-mod|w3c-keyname|crelt)[\\/]/.test(id)) return 'notebook-editor';
        },
      },
    },
    // Plotly is intentionally isolated behind a dynamic import and has its own
    // stricter named budget above. Vite's global warning threshold can therefore
    // acknowledge that one lazy scientific-visualization vendor chunk without
    // hiding growth in the application or page chunks.
    chunkSizeWarningLimit: PLOTLY_CHUNK_BUDGET / 1000,
  }
});
