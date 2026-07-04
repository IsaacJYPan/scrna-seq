// Preload for local full-stack dev scripts.
//
// The durable pipeline UI creates queued jobs. Running it locally through
// `npm run dev` should drain those jobs, while `npm start` / `node server.js`
// remain conservative unless the caller explicitly sets ENABLE_JOB_WORKER=true.
if (process.env.ENABLE_JOB_WORKER === undefined || process.env.ENABLE_JOB_WORKER === '') {
  process.env.ENABLE_JOB_WORKER = 'true';
}
