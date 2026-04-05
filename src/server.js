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
} from './config.js';
import {
  getClient,
  insertClip,
  listClips,
  pickUploadFilename,
  saveFileToGridFS,
  listUploadedFiles,
  openDownloadStreamForFilename,
  purgeExpiredGridFSFiles,
} from './mongo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

const PORT = configPort;

function checkUploadAuth(req, res, next) {
  if (!uploadSecret) return next();
  const t = req.headers['x-upload-token'];
  if (t !== uploadSecret) {
    return res.status(401).json({ error: 'Upload not authorized', needToken: true });
  }
  return next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 95 * 1024 * 1024 },
});

const MAX_TEXT_CHARS = 5 * 1024 * 1024;

const app = express();
app.set('trust proxy', trustProxy);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));

app.post('/api/upload', checkUploadAuth, upload.array('files', 100), async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'No files received' });
  }
  try {
    const saved = [];
    for (const f of files) {
      const name = await pickUploadFilename(f.originalname);
      await saveFileToGridFS(f.buffer, name);
      saved.push(name);
    }
    res.json({ ok: true, saved, count: saved.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.post('/api/text', checkUploadAuth, async (req, res) => {
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
  try {
    const id = await insertClip(text);
    res.json({ ok: true, saved: id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save text' });
  }
});

app.get('/api/clipboard', async (_req, res) => {
  try {
    const items = await listClips();
    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load clipboard' });
  }
});

app.get('/api/files', async (_req, res) => {
  try {
    const files = await listUploadedFiles();
    res.json({ files, ttlMinutes: fileTtlMinutes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not list files' });
  }
});

app.get('/api/file/:filename', async (req, res) => {
  try {
    const r = await openDownloadStreamForFilename(req.params.filename);
    if (!r) {
      return res.status(404).end();
    }
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(r.filename)}"`);
    r.stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
    });
    r.stream.pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

ensureDir(publicDir);

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'home.html'));
});

app.use(express.static(publicDir, { index: false }));

setInterval(() => {
  purgeExpiredGridFSFiles().catch((e) => console.error('[drop] purge', e));
}, 60 * 1000);

async function start() {
  await getClient();
  await purgeExpiredGridFSFiles();

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
    console.log('  Drop — MongoDB storage — http://0.0.0.0:' + PORT);
    console.log('  Open:  http://localhost:' + PORT + '/');
    if (lan) console.log('  LAN:   http://' + lan + ':' + PORT + '/');
    console.log('  TTL:   ' + fileTtlMinutes + ' minutes (clips + files)');
    if (uploadSecret) console.log('  uploadSecret: set');
    console.log('');
  });
}

start().catch((err) => {
  console.error('[drop] failed to start:', err);
  process.exit(1);
});
