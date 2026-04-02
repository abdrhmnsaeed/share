import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  uploadSecret,
  trustProxy,
  port as configPort,
  fileTtlMinutes,
  receivedDir as configReceivedDir,
} from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');

function resolveReceivedDir() {
  if (process.env.RECEIVED_DIR) {
    return path.resolve(process.env.RECEIVED_DIR);
  }
  if (configReceivedDir && String(configReceivedDir).trim()) {
    return path.resolve(configReceivedDir);
  }
  if (process.env.VERCEL) {
    return path.join(os.tmpdir(), 'drop-received');
  }
  return path.join(root, 'received');
}

let receivedDir = resolveReceivedDir();

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function initStorage() {
  try {
    ensureDir(receivedDir);
  } catch (err) {
    const fallback = path.join(os.tmpdir(), 'drop-received');
    console.warn('[drop] could not create', receivedDir, '→', fallback, err?.message || err);
    receivedDir = fallback;
    ensureDir(receivedDir);
  }
}

const PORT = configPort;
const FILE_TTL_MS = fileTtlMinutes * 60 * 1000;

function checkUploadAuth(req, res, next) {
  if (!uploadSecret) return next();
  const t = req.headers['x-upload-token'];
  if (t !== uploadSecret) {
    return res.status(401).json({ error: 'Upload not authorized', needToken: true });
  }
  return next();
}

function safeFilePath(filename) {
  const safe = path.basename(filename);
  const dir = path.resolve(receivedDir);
  const full = path.resolve(path.join(dir, safe));
  if (!full.startsWith(dir + path.sep) && full !== dir) return null;
  return full;
}

function listFiles() {
  ensureDir(receivedDir);
  const names = fs.readdirSync(receivedDir).filter((n) => !n.startsWith('.'));
  names.sort((a, b) => b.localeCompare(a));
  return names.map((name) => {
    const fp = path.join(receivedDir, name);
    let size = 0;
    try {
      size = fs.statSync(fp).size;
    } catch {
      /* ignore */
    }
    const lower = name.toLowerCase();
    const isText =
      lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.json');
    return { name, size, isText };
  });
}

function purgeOldFiles() {
  if (!fs.existsSync(receivedDir)) return;
  const now = Date.now();
  for (const name of fs.readdirSync(receivedDir)) {
    if (name.startsWith('.')) continue;
    const fp = path.join(receivedDir, name);
    try {
      const st = fs.statSync(fp);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs > FILE_TTL_MS) fs.unlinkSync(fp);
    } catch {
      /* ignore */
    }
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureDir(receivedDir);
    cb(null, receivedDir);
  },
  filename: (_req, file, cb) => {
    const base = path.basename(file.originalname).replace(/[^a-zA-Z0-9._\- ()]+/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `${stamp}_${base}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 * 4 },
});

const MAX_TEXT_CHARS = 5 * 1024 * 1024;

const app = express();
app.set('trust proxy', trustProxy);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));

app.post('/api/upload', checkUploadAuth, upload.array('files', 100), (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'No files received' });
  }
  res.json({ ok: true, saved: files.map((f) => f.filename), count: files.length });
});

app.post('/api/text', checkUploadAuth, (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string') {
    return res.status(400).json({ error: 'Expected JSON { "text": "..." }' });
  }
  if (text.length === 0) {
    return res.status(400).json({ error: 'Text is empty' });
  }
  if (text.length > MAX_TEXT_CHARS) {
    return res.status(400).json({ error: 'Text too large (max 5 MB)' });
  }
  ensureDir(receivedDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${stamp}_paste.txt`;
  fs.writeFileSync(path.join(receivedDir, filename), text, 'utf8');
  res.json({ ok: true, saved: filename });
});

app.get('/api/files', (_req, res) => {
  res.json({ files: listFiles(), ttlMinutes: fileTtlMinutes });
});

app.get('/api/file/:filename', (req, res) => {
  const fp = safeFilePath(req.params.filename);
  if (!fp || !fs.existsSync(fp)) {
    return res.status(404).end();
  }
  res.download(fp, path.basename(fp));
});

initStorage();
ensureDir(publicDir);

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'home.html'));
});

app.use(express.static(publicDir, { index: false }));

setInterval(purgeOldFiles, 60 * 1000);
purgeOldFiles();

app.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  let lan = '';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const fam = net.family;
      if ((fam === 'IPv4' || fam === 4) && !net.internal) {
        lan = net.address;
        break;
      }
    }
    if (lan) break;
  }
  console.log('');
  console.log('  Drop — http://0.0.0.0:' + PORT);
  console.log('  Open:  http://localhost:' + PORT + '/');
  if (lan) console.log('  LAN:   http://' + lan + ':' + PORT + '/');
  console.log('  Storage:', receivedDir);
  console.log('  File TTL:', fileTtlMinutes, 'minutes');
  if (uploadSecret) console.log('  uploadSecret: set (required for POST /api/upload and /api/text)');
  console.log('');
});
