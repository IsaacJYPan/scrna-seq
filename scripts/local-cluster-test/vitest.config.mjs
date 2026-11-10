import {configDefaults,defineConfig} from 'vitest/config';

// The installed Vite transformer relocates the CLI hashbang after imports.
// Load these Node-only entry points natively instead, preserving their bytes.
export default defineConfig({test:{
  exclude:[...configDefaults.exclude,'scratch/**','out/**','release/**'],
  globals:true,
  environment:'node',
  setupFiles:['./src/setupTests.js'],
  fileParallelism:false,
  testTimeout:30000,
  server:{deps:{external:[/[/\\]cli[/\\]traceomics(?:-mcp)?\.mjs$/]}},
}});
