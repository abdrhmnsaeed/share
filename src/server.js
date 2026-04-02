import express from 'express';
import multer from 'multer';
import cors from 'cors';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { createRoom, validateRoom } from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const receivedDir = path.join(root, 'received');
const publicDir = path.join(root, 'public');

const PORT = Number(process.env.PORT) || 8742;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function getLanIPv4s() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const fam = net.family;
      if ((fam === 'IPv4' || fam === 4) && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/** Public base URL for links and QR (set PUBLIC_URL when behind a reverse proxy). */
function getPublicBaseUrl(req) {
  const fromEnv = process.env.PUBLIC_URL;
  if (fromEnv && typeof fromEnv === 'string') {
    return fromEnv.replace(/\/$/, '');
  }
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function readJoinHtml(roomId, token) {
  const raw = fs.readFileSync(path.join(publicDir, 'join.html'), 'utf8');
  return raw.replace(/__SESSION_TOKEN__/g, token).replace(/__ROOM_ID__/g, roomId);
}

function requireRoomHeader(req, res, next) {
  const secret = req.headers['x-session-token'];
  if (!validateRoom(req.params.roomId, secret)) {
    return res.status(401).json({ error: 'Invalid room or secret' });
  }
  return next();
}

function roomAuthFlexible(req, res, next) {
  const secret = req.headers['x-session-token'] || req.body?.token || req.query?.token;
  if (!validateRoom(req.params.roomId, secret)) {
    return res.status(401).json({ error: 'Invalid room or secret' });
  }
  return next();
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dir = path.join(receivedDir, req.params.roomId);
    ensureDir(dir);
    cb(null, dir);
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
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));

app.post('/api/rooms', (req, res) => {
  const { roomId, secret } = createRoom();
  const base = getPublicBaseUrl(req);
  const hostUrl = `${base}/host/${roomId}?t=${encodeURIComponent(secret)}`;
  const joinUrl = `${base}/join/${roomId}?t=${encodeURIComponent(secret)}`;
  res.json({ roomId, hostUrl, joinUrl });
});

app.get('/join/:roomId', (req, res) => {
  const { roomId } = req.params;
  const t = req.query.t;
  if (!t || !validateRoom(roomId, t)) {
    res.status(403).type('html').send('<p>Invalid or expired room. Ask for a new invite link from the host.</p>');
    return;
  }
  res.type('html').send(readJoinHtml(roomId, t));
});

app.get('/host/:roomId', async (req, res) => {
  const { roomId } = req.params;
  const t = req.query.t;
  if (!t || !validateRoom(roomId, t)) {
    res.status(403).type('html').send('<p>Invalid or expired room. Create a new room from the home page.</p>');
    return;
  }

  const base = getPublicBaseUrl(req);
  const joinUrl = `${base}/join/${roomId}?t=${encodeURIComponent(t)}`;
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 280, margin: 2 });
  } catch {
    qrDataUrl = '';
  }

  const ips = getLanIPv4s();
  const addrLines = ips.length
    ? ips.map((ip) => `<li><code>${ip}</code></li>`).join('')
    : '<li><em>No LAN IPv4 — use the public link if hosted, or connect this PC to Wi‑Fi</em></li>';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0f1419" />
  <title>LAN Drop — Room ${roomId}</title>
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
  <script src="/pwa-register.js" defer></script>
  <style>
    :root { font-family: system-ui, Segoe UI, sans-serif; background: #0f1419; color: #e7e9ea; }
    body { max-width: 42rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    h1 { font-size: 1.35rem; font-weight: 600; }
    .qr { background: #fff; padding: 12px; display: inline-block; border-radius: 8px; margin: 1rem 0; }
    .qr img { display: block; width: 280px; height: 280px; }
    code, .url { word-break: break-all; font-size: 0.85rem; background: #1d2730; padding: 2px 6px; border-radius: 4px; }
    .box { background: #1a2330; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
    ul { padding-left: 1.2rem; }
    .muted { color: #8b98a5; font-size: 0.9rem; }
    button { cursor: pointer; background: #1d9bf0; color: #fff; border: 0; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.95rem; }
    button:hover { filter: brightness(1.08); }
    #list { margin-top: 0.5rem; font-size: 0.9rem; max-height: 14rem; overflow: auto; }
    #list li { margin: 0.25rem 0; }
    .back a { color: #1d9bf0; font-size: 0.9rem; text-decoration: none; }
  </style>
</head>
<body>
  <p class="back"><a href="/">← Home</a></p>
  <h1>Room <code>${roomId}</code> — host</h1>
  <p class="muted">Share the QR or link so others can join. Rooms expire about 48 hours after creation.</p>
  <div class="qr">${qrDataUrl ? `<img src="${qrDataUrl}" alt="QR" width="280" height="280" />` : '<p>Could not generate QR.</p>'}</div>
  <div class="box">
    <div><strong>Join link</strong></div>
    <p class="url">${joinUrl}</p>
    <p><button type="button" id="copyJoin">Copy join link</button></p>
  </div>
  <div class="box">
    <div><strong>Manual join</strong></div>
    <p>Room ID: <code>${roomId}</code></p>
    <p>Secret: <code id="secretCopy">${t}</code> <button type="button" id="copySecret">Copy secret</button></p>
  </div>
  <div class="box">
    <div><strong>Server / LAN (this machine)</strong></div>
    <ul>${addrLines}</ul>
  </div>
  <div class="box">
    <div><strong>Received in this room</strong> <button type="button" id="refresh">Refresh</button></div>
    <ul id="list"></ul>
    <p class="muted">On this PC: <code>received\\${roomId}\\</code></p>
  </div>
  <script>
    const TOKEN = ${JSON.stringify(t)};
    const ROOM = ${JSON.stringify(roomId)};
    document.getElementById('copyJoin').onclick = () => {
      navigator.clipboard.writeText(${JSON.stringify(joinUrl)}).then(() => {
        document.getElementById('copyJoin').textContent = 'Copied';
        setTimeout(() => { document.getElementById('copyJoin').textContent = 'Copy join link'; }, 2000);
      });
    };
    document.getElementById('copySecret').onclick = () => {
      navigator.clipboard.writeText(document.getElementById('secretCopy').textContent).then(() => {
        document.getElementById('copySecret').textContent = 'Copied';
        setTimeout(() => { document.getElementById('copySecret').textContent = 'Copy secret'; }, 2000);
      });
    };
    async function loadList() {
      const r = await fetch('/api/rooms/' + encodeURIComponent(ROOM) + '/received?token=' + encodeURIComponent(TOKEN));
      const j = await r.json();
      const ul = document.getElementById('list');
      ul.innerHTML = '';
      if (!j.files || j.files.length === 0) {
        ul.innerHTML = '<li class="muted">No files yet</li>';
        return;
      }
      for (const f of j.files) {
        const li = document.createElement('li');
        li.textContent = f;
        ul.appendChild(li);
      }
    }
    document.getElementById('refresh').onclick = loadList;
    loadList();
    setInterval(loadList, 8000);
  </script>
</body>
</html>`;
  res.type('html').send(html);
});

app.post('/api/rooms/:roomId/upload', requireRoomHeader, upload.array('files', 100), (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'No files received' });
  }
  const names = files.map((f) => f.filename);
  res.json({ ok: true, saved: names, count: names.length });
});

app.post('/api/rooms/:roomId/text', roomAuthFlexible, (req, res) => {
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
  const { roomId } = req.params;
  const dir = path.join(receivedDir, roomId);
  ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${stamp}_paste.txt`;
  fs.writeFileSync(path.join(dir, filename), text, 'utf8');
  res.json({ ok: true, saved: filename });
});

app.get('/api/rooms/:roomId/received', (req, res) => {
  const t = req.headers['x-session-token'] || req.query.token;
  if (!validateRoom(req.params.roomId, t)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const dir = path.join(receivedDir, req.params.roomId);
  ensureDir(dir);
  const names = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  names.sort((a, b) => b.localeCompare(a));
  res.json({ files: names });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'home.html'));
});

ensureDir(publicDir);
app.use(express.static(publicDir, { index: false }));

app.listen(PORT, '0.0.0.0', () => {
  const ips = getLanIPv4s();
  const host = ips[0] || '127.0.0.1';
  console.log('');
  console.log('  LAN Drop — listening on 0.0.0.0 port', PORT);
  console.log('  Home:  http://localhost:' + PORT + '/');
  if (process.env.PUBLIC_URL) {
    console.log('  PUBLIC_URL:', process.env.PUBLIC_URL);
  }
  console.log('  Example on LAN: http://' + host + ':' + PORT + '/');
  console.log('');
  console.log('  Files: ', receivedDir);
  console.log('');
});
