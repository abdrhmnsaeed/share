import express from 'express';
import multer from 'multer';
import cors from 'cors';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  createRoom,
  validateRoom,
  getRoomExpiry,
  purgeExpiredRooms,
  ROOM_TTL_MS,
} from './rooms.js';
import {
  publicUrl as configPublicUrl,
  createRoomSecret,
  trustProxy,
  port as configPort,
  roomTtlMinutes,
} from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const receivedDir = path.join(root, 'received');
const publicDir = path.join(root, 'public');

const PORT = configPort;

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

function getPublicBaseUrl(req) {
  if (configPublicUrl && typeof configPublicUrl === 'string') {
    return configPublicUrl.replace(/\/$/, '');
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

function safeRoomFilePath(roomId, filename) {
  const safe = path.basename(filename);
  const dir = path.resolve(path.join(receivedDir, roomId));
  const full = path.resolve(path.join(dir, safe));
  if (!full.startsWith(dir + path.sep) && full !== dir) return null;
  return full;
}

function listRoomFiles(roomId) {
  const dir = path.join(receivedDir, roomId);
  ensureDir(dir);
  const names = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  names.sort((a, b) => b.localeCompare(a));
  return names.map((name) => {
    const fp = path.join(dir, name);
    let size = 0;
    try {
      size = fs.statSync(fp).size;
    } catch {
      /* ignore */
    }
    const lower = name.toLowerCase();
    const isText = lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.json');
    return { name, size, isText };
  });
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
app.set('trust proxy', trustProxy);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));

app.post('/api/rooms', (req, res) => {
  if (createRoomSecret && req.headers['x-create-token'] !== createRoomSecret) {
    return res.status(401).json({ error: 'Create not authorized', needToken: true });
  }
  const { roomId, secret } = createRoom();
  const base = getPublicBaseUrl(req);
  const hostUrl = `${base}/host/${roomId}?t=${encodeURIComponent(secret)}`;
  const joinUrl = `${base}/join/${roomId}?t=${encodeURIComponent(secret)}`;
  res.json({
    roomId,
    hostUrl,
    joinUrl,
    ttlMinutes: Math.round(ROOM_TTL_MS / 60000),
  });
});

app.get('/api/rooms/:roomId/info', (req, res) => {
  const t = req.headers['x-session-token'] || req.query.token;
  if (!validateRoom(req.params.roomId, t)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const ex = getRoomExpiry(req.params.roomId);
  if (!ex) return res.status(404).json({ error: 'Room not found' });
  res.json({
    expiresAt: ex.expiresAt,
    ttlMinutes: Math.round(ROOM_TTL_MS / 60000),
  });
});

app.get('/join/:roomId', (req, res) => {
  const { roomId } = req.params;
  const t = req.query.t;
  if (!t || !validateRoom(roomId, t)) {
    res
      .status(403)
      .type('html')
      .send(
        '<p>Invalid or expired room. Rooms auto-delete after about an hour. Ask the host for a new link.</p>',
      );
    return;
  }
  res.type('html').send(readJoinHtml(roomId, t));
});

app.get('/host/:roomId', async (req, res) => {
  const { roomId } = req.params;
  const t = req.query.t;
  if (!t || !validateRoom(roomId, t)) {
    res
      .status(403)
      .type('html')
      .send('<p>Invalid or expired room. Create a new room from your PC (home page).</p>');
    return;
  }

  const base = getPublicBaseUrl(req);
  const joinUrl = `${base}/join/${roomId}?t=${encodeURIComponent(t)}`;
  const ttlMin = Math.round(ROOM_TTL_MS / 60000);
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 280, margin: 2 });
  } catch {
    qrDataUrl = '';
  }

  const ips = getLanIPv4s();
  const addrLines = ips.length
    ? ips.map((ip) => `<li><code>${ip}</code></li>`).join('')
    : '<li><em>When hosted, use the link below — devices don’t need the same Wi‑Fi.</em></li>';

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
    button, .btnlink {
      cursor: pointer; background: #1d9bf0; color: #fff; border: 0; padding: 0.35rem 0.65rem; border-radius: 6px;
      font-size: 0.85rem; text-decoration: none; display: inline-block;
    }
    button.secondary, .btnlink.secondary { background: #38444d; }
    button:hover { filter: brightness(1.08); }
    #list { margin-top: 0.5rem; font-size: 0.9rem; max-height: 16rem; overflow: auto; }
    #list li { margin: 0.35rem 0; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    #list .fname { flex: 1; min-width: 0; word-break: break-all; }
    .back a { color: #1d9bf0; font-size: 0.9rem; text-decoration: none; }
    #expiry { font-weight: 600; color: #ffad1f; }
  </style>
</head>
<body>
  <p class="back"><a href="/">← Home</a></p>
  <h1>Room <code>${roomId}</code> — host (PC)</h1>
  <p class="muted">Share the join link or QR with any device online — they don’t need your Wi‑Fi. This room and its files are deleted about <strong>${ttlMin} min</strong> after creation. <span id="expiry"></span></p>
  <div class="qr">${qrDataUrl ? `<img src="${qrDataUrl}" alt="QR" width="280" height="280" />` : '<p>Could not generate QR.</p>'}</div>
  <div class="box">
    <div><strong>Join link</strong></div>
    <p class="url">${joinUrl}</p>
    <p><button type="button" id="copyJoin">Copy join link</button></p>
  </div>
  <div class="box">
    <div><strong>Manual join</strong></div>
    <p>Room ID: <code>${roomId}</code></p>
    <p>Secret: <code id="secretCopy">${t}</code> <button type="button" class="secondary" id="copySecret">Copy secret</button></p>
  </div>
  <div class="box">
    <div><strong>Local / optional</strong></div>
    <ul>${addrLines}</ul>
  </div>
  <div class="box">
    <div><strong>Files in this room</strong> <button type="button" class="secondary" id="refresh">Refresh</button></div>
    <ul id="list"></ul>
    <p class="muted">Server folder: <code>received\\${roomId}\\</code></p>
  </div>
  <script>
    const TOKEN = ${JSON.stringify(t)};
    const ROOM = ${JSON.stringify(roomId)};
    const joinUrlStr = ${JSON.stringify(joinUrl)};

    function fmtBytes(n) {
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function fileUrl(name) {
      return '/api/rooms/' + encodeURIComponent(ROOM) + '/file/' + encodeURIComponent(name) + '?token=' + encodeURIComponent(TOKEN);
    }

    document.getElementById('copyJoin').onclick = () => {
      navigator.clipboard.writeText(joinUrlStr).then(() => {
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

    async function loadExpiry() {
      const r = await fetch('/api/rooms/' + encodeURIComponent(ROOM) + '/info?token=' + encodeURIComponent(TOKEN));
      const j = await r.json().catch(() => ({}));
      if (j.expiresAt) {
        const left = Math.max(0, j.expiresAt - Date.now());
        const m = Math.floor(left / 60000);
        const s = Math.floor((left % 60000) / 1000);
        document.getElementById('expiry').textContent = 'Time left: ' + m + 'm ' + s + 's';
      }
    }

    async function loadList() {
      const r = await fetch('/api/rooms/' + encodeURIComponent(ROOM) + '/received?token=' + encodeURIComponent(TOKEN));
      const j = await r.json();
      const ul = document.getElementById('list');
      ul.innerHTML = '';
      const files = j.files || [];
      if (files.length === 0) {
        ul.innerHTML = '<li class="muted">No files yet</li>';
        return;
      }
      for (const f of files) {
        const li = document.createElement('li');
        const name = typeof f === 'string' ? f : f.name;
        const size = typeof f === 'object' && f.size != null ? f.size : 0;
        const isText = typeof f === 'object' && f.isText;
        const span = document.createElement('span');
        span.className = 'fname';
        span.textContent = name + ' (' + fmtBytes(size) + ')';
        li.appendChild(span);
        const a = document.createElement('a');
        a.className = 'btnlink';
        a.href = fileUrl(name);
        a.target = '_blank';
        a.rel = 'noopener';
        a.download = '';
        a.textContent = 'Download';
        li.appendChild(a);
        if (isText) {
          const c = document.createElement('button');
          c.type = 'button';
          c.className = 'secondary';
          c.textContent = 'Copy text';
          c.onclick = async () => {
            const tr = await fetch(fileUrl(name));
            const tx = await tr.text();
            await navigator.clipboard.writeText(tx);
            c.textContent = 'Copied';
            setTimeout(() => { c.textContent = 'Copy text'; }, 2000);
          };
          li.appendChild(c);
        }
        ul.appendChild(li);
      }
    }
    document.getElementById('refresh').onclick = () => { loadList(); loadExpiry(); };
    loadList();
    loadExpiry();
    setInterval(() => { loadList(); loadExpiry(); }, 8000);
    setInterval(loadExpiry, 1000);
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
  const files = listRoomFiles(req.params.roomId);
  res.json({ files });
});

app.get('/api/rooms/:roomId/file/:filename', (req, res) => {
  const tok = req.query.token;
  if (!validateRoom(req.params.roomId, tok)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const fp = safeRoomFilePath(req.params.roomId, req.params.filename);
  if (!fp || !fs.existsSync(fp)) {
    return res.status(404).end();
  }
  res.download(fp, path.basename(fp));
});

ensureDir(receivedDir);
ensureDir(publicDir);

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'home.html'));
});

app.use(express.static(publicDir, { index: false }));

setInterval(() => purgeExpiredRooms(receivedDir), 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  const ips = getLanIPv4s();
  const host = ips[0] || '127.0.0.1';
  console.log('');
  console.log('  LAN Drop — http://0.0.0.0:' + PORT);
  console.log('  Home:  http://localhost:' + PORT + '/');
  if (configPublicUrl) console.log('  publicUrl (config):', configPublicUrl);
  console.log('  Room TTL:', roomTtlMinutes, 'minutes');
  if (createRoomSecret) console.log('  createRoomSecret: set (required for POST /api/rooms)');
  console.log('  Storage:', receivedDir);
  console.log('  Example LAN:', 'http://' + host + ':' + PORT + '/');
  console.log('');
});
