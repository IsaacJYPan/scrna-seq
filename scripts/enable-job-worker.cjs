// Preload for local full-stack dev scripts.
//
// Used only by `npm run worker` / `npm run worker:once`: choosing those commands
// is the explicit opt-in, even if a shared environment file defaults the flag to
// false. Direct `node worker.js` remains fail-closed unless its environment opts in.
process.env.ENABLE_JOB_WORKER = 'true';
