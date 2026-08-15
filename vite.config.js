import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const STANDARD_CHUNK_BUDGET = 600_000;
const PLOTLY_CHUNK_BUDGET = 5_500_000;

function enforceChunkBudgets() {
  return {
    name: 'enforce-chunk-budgets',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
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
    // Plotly is intentionally isolated behind a dynamic import and has its own
    // stricter named budget above. Vite's global warning threshold can therefore
    // acknowledge that one lazy scientific-visualization vendor chunk without
    // hiding growth in the application or page chunks.
    chunkSizeWarningLimit: PLOTLY_CHUNK_BUDGET / 1000,
  }
});
