import crypto from 'crypto';

/** @type {Map<string, { secret: string, createdAt: number }>} */
const rooms = new Map();

const ROOM_TTL_MS = 48 * 60 * 60 * 1000;

export function createRoom() {
  const roomId = crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(24).toString('hex');
  rooms.set(roomId, { secret, createdAt: Date.now() });
  return { roomId, secret };
}

export function getRoom(roomId) {
  const r = rooms.get(roomId);
  if (!r) return null;
  if (Date.now() - r.createdAt > ROOM_TTL_MS) {
    rooms.delete(roomId);
    return null;
  }
  return r;
}

export function validateRoom(roomId, secret) {
  const r = getRoom(roomId);
  return !!(r && r.secret === secret);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, v] of rooms) {
    if (now - v.createdAt > ROOM_TTL_MS) rooms.delete(id);
  }
}, 15 * 60 * 1000);
