const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const db = require('./backend/database');

const app = express();
const PORT = process.env.PORT || 3000;
const PLUMBER_PORT = process.env.PLUMBER_PORT || 8000;

// Plumber auth token
const API_TOKEN = crypto.randomBytes(32).toString('hex');

// Init Database
const DB_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
db.initDatabase(path.join(DB_DIR, 'dashboard.db'));

// Middleware
app.use(cors());
app.use(express.json());

// Session Middleware (Dummy single-user session for now, or multi-user if clients send a header)
app.use((req, res, next) => {
  // Real app: verify JWT and get user ID.
  // Here, we trust the client to send an X-Client-ID or we assign a generic one.
  const clientId = req.headers['x-client-id'] || 'default-web-user';
  req.session = { id: clientId };
  next();
});

// ── Database API Endpoints ──────────────────────────────────────────────

app.get('/api/db/provenance', (req, res) => {
  res.json(db.getAllProvenance());
});

app.post('/api/db/provenance', (req, res) => {
  const env = req.body;
  try {
    const id = db.saveProvenance(env);
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/db/provenance/:id', (req, res) => {
  res.json(db.getProvenance(req.params.id));
});

app.get('/api/db/provenance-chain/:id', (req, res) => {
  res.json(db.getProvenanceChain(req.params.id));
});

app.delete('/api/db/provenance/:id', (req, res) => {
  res.json({ success: db.deleteProvenance(req.params.id) });
});

app.get('/api/db/figures', (req, res) => {
  // In real app, filter by req.session.user.email
  const email = req.query.email || 'guest@local';
  res.json(db.getFiguresByUser(email));
});

app.post('/api/db/figures', (req, res) => {
  try {
    const id = db.saveFigure(req.body);
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/db/figures/:id', (req, res) => {
  res.json({ success: db.deleteFigure(req.params.id) });
});

// Cache Endpoints
app.post('/api/db/cache-key', (req, res) => {
  const { operation, params, dataVersion, parentIds } = req.body;
  res.json({ key: db.makeCacheKey(operation, params, dataVersion, parentIds) });
});

app.get('/api/db/cache/:key', (req, res) => {
  res.json(db.getCachedResult(req.params.key));
});

app.post('/api/db/cache/:key', (req, res) => {
  const { provenanceId, resultData } = req.body;
  res.json({ success: db.setCachedResult(req.params.key, provenanceId, resultData) });
});

app.delete('/api/db/cache', (req, res) => {
  db.clearCache();
  res.json({ success: true });
});

// ── File Upload API (Replacing Desktop Dialogs) ─────────────────────────
// For a cloud app, the user cannot pick a local path and send it to R.
// They must upload the file to the Node.js server, which places it somewhere R can read.
const upload = multer({ dest: 'data/uploads/' });

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // The file is saved at req.file.path. R can read it directly.
  res.json({ path: path.resolve(req.file.path), originalName: req.file.originalname });
});

// ── R Plumber Proxy ─────────────────────────────────────────────────────
// Forward all /api/r/* requests to localhost:8000/*
app.use('/api/r', createProxyMiddleware({
  target: `http://127.0.0.1:${PLUMBER_PORT}`,
  changeOrigin: true,
  pathRewrite: {
    '^/api/r': '', // remove /api/r base
  },
  on: {
    proxyReq: (proxyReq, req, res) => {
      // Inject required headers for Plumber
      proxyReq.setHeader('X-API-Token', API_TOKEN);
      
      // Pass the session ID to isolate users in R
      proxyReq.setHeader('X-Object-ID', req.session.id);
    }
  }
}));

// ── Static Frontend ─────────────────────────────────────────────────────
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  // SPA routing fallback
  app.use((req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.send('Frontend not built. Run `npm run build` or use Vite dev server.');
  });
}

// ── Launch R Plumber ────────────────────────────────────────────────────
function findRscript() {
  const candidates = [
    'C:\\Program Files\\R\\R-4.5.1\\bin\\Rscript.exe',
    'Rscript'
  ];
  for (const c of candidates) {
    // If it's absolute, check exists. If 'Rscript', just assume it works.
    if (path.isAbsolute(c) && fs.existsSync(c)) return c;
    if (c === 'Rscript') return c;
  }
  return 'Rscript';
}

function startPlumber() {
  const rscript = findRscript();
  const plumberScript = path.join(__dirname, 'r-backend', 'run.R');
  
  const rProcess = spawn(rscript, [plumberScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, API_TOKEN, PLUMBER_PORT: String(PLUMBER_PORT) }
  });

  rProcess.stdout.on('data', d => console.log(`[R] ${d.toString().trim()}`));
  rProcess.stderr.on('data', d => console.log(`[R:err] ${d.toString().trim()}`));
  rProcess.on('close', code => console.log(`R process exited with code ${code}`));

  process.on('exit', () => rProcess.kill());
}

// Start Server
app.listen(PORT, () => {
  console.log(`Node.js Web Server running on http://localhost:${PORT}`);
  console.log(`Starting local R Plumber backend...`);
  startPlumber();
});
