import { MongoClient, GridFSBucket } from 'mongodb';
import path from 'path';
import { fileTtlMinutes } from './config.js';

/**
 * Atlas connection (database name in URI path: /store).
 * Rotate credentials if this file is ever exposed publicly.
 */
export const MONGO_URI =
  'mongodb+srv://blogUser:DQJjHXY3RGe4es6U@cluster0.lpmv7eb.mongodb.net/store';

const DB_NAME = 'store';
const BUCKET_NAME = 'filedrops';

/** TTL in seconds (MongoDB clips + our GridFS purge both use this window) */
export const TTL_SECONDS = fileTtlMinutes * 60;

const cutoffDate = () => new Date(Date.now() - fileTtlMinutes * 60 * 1000);

let client;
let connectPromise;
let bucket;

export async function getClient() {
  if (client) return client;
  if (!connectPromise) {
    connectPromise = (async () => {
      const c = new MongoClient(MONGO_URI);
      await c.connect();
      client = c;
      await ensureIndexes();
      return c;
    })();
  }
  await connectPromise;
  return client;
}

export function getDb() {
  if (!client) throw new Error('Mongo not connected');
  return client.db(DB_NAME);
}

export async function getBucket() {
  await getClient();
  if (!bucket) {
    bucket = new GridFSBucket(getDb(), { bucketName: BUCKET_NAME });
  }
  return bucket;
}

async function ensureIndexes() {
  const db = client.db(DB_NAME);
  await db.collection('clips').createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
  await db
    .collection(`${BUCKET_NAME}.files`)
    .createIndex({ uploadDate: 1 })
    .catch(() => {});
}

export function isClipFilename(name) {
  return /^clip-.+\.txt$/i.test(name);
}

export async function insertClip(text) {
  await getClient();
  const db = getDb();
  const r = await db.collection('clips').insertOne({ text, createdAt: new Date() });
  return r.insertedId.toString();
}

export async function listClips(limit = 80, maxBytes = 2 * 1024 * 1024) {
  await getClient();
  const db = getDb();
  const cursor = db.collection('clips').find().sort({ createdAt: -1 }).limit(limit);
  const docs = await cursor.toArray();
  const items = [];
  let totalBytes = 0;
  for (const d of docs) {
    const t = d.text;
    const len = Buffer.byteLength(t, 'utf8');
    if (totalBytes + len > maxBytes) {
      if (totalBytes >= maxBytes) break;
      let cut = t.length;
      const budget = maxBytes - totalBytes;
      while (cut > 0 && Buffer.byteLength(t.slice(0, cut), 'utf8') > budget) cut -= 1;
      items.push({ id: d._id.toString(), text: t.slice(0, cut), truncated: true });
      break;
    }
    totalBytes += len;
    items.push({ id: d._id.toString(), text: t });
  }
  return items;
}

async function gridFsFilenameExists(filename) {
  await getClient();
  const n = await getDb()
    .collection(`${BUCKET_NAME}.files`)
    .countDocuments({ filename, uploadDate: { $gte: cutoffDate() } });
  return n > 0;
}

export async function pickUploadFilename(originalname) {
  let base = path.basename(originalname).replace(/[^a-zA-Z0-9._\- ()]+/g, '_') || 'file';
  if (isClipFilename(base)) base = `file_${base}`;
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let name = base;
  if (!(await gridFsFilenameExists(name))) return name;
  for (let n = 1; n < 500; n++) {
    name = `${stem} (${n})${ext}`;
    if (!(await gridFsFilenameExists(name))) return name;
  }
  return `${stem}_${Date.now()}${ext}`;
}

export async function saveFileToGridFS(buffer, filename) {
  const b = await getBucket();
  return new Promise((resolve, reject) => {
    const uploadStream = b.openUploadStream(filename);
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => resolve(filename));
    uploadStream.end(buffer);
  });
}

export async function listUploadedFiles() {
  await getClient();
  const db = getDb();
  const minDate = cutoffDate();
  const docs = await db
    .collection(`${BUCKET_NAME}.files`)
    .find({ uploadDate: { $gte: minDate } })
    .sort({ uploadDate: -1 })
    .toArray();
  return docs.map((d) => {
    const name = d.filename;
    const lower = name.toLowerCase();
    const isText =
      lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.json');
    return { name, size: d.length, isText };
  });
}

export async function openDownloadStreamForFilename(filename) {
  await getClient();
  const safe = path.basename(filename);
  const db = getDb();
  const b = await getBucket();
  const doc = await db
    .collection(`${BUCKET_NAME}.files`)
    .find({ filename: safe, uploadDate: { $gte: cutoffDate() } })
    .sort({ uploadDate: -1 })
    .limit(1)
    .next();
  if (!doc) return null;
  return { stream: b.openDownloadStream(doc._id), filename: safe };
}

/** GridFS does not TTL-delete chunks safely; purge old file docs + chunks with bucket.delete */
export async function purgeExpiredGridFSFiles() {
  await getClient();
  const db = getDb();
  const b = await getBucket();
  const minDate = cutoffDate();
  const old = await db
    .collection(`${BUCKET_NAME}.files`)
    .find({ uploadDate: { $lt: minDate } })
    .toArray();
  for (const f of old) {
    try {
      await b.delete(f._id);
    } catch {
      /* ignore */
    }
  }
}
