import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { roomTtlMinutes } from './config.js';

/** @type {Map<string, { secret: string, createdAt: number }>} */
const rooms = new Map();

export const ROOM_TTL_MS = roomTtlMinutes * 60 * 1000;

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

/** @returns {{ expiresAt: number } | null} */
export function getRoomExpiry(roomId) {
  const r = getRoom(roomId);
  if (!r) return null;
  return { expiresAt: r.createdAt + ROOM_TTL_MS };
}

/**
 * Remove expired rooms from memory and delete their folders under receivedRoot.
 * No database: rooms map + filesystem only.
 */
export function purgeExpiredRooms(receivedRoot) {
  const now = Date.now();
  for (const [id, v] of rooms) {
    if (now - v.createdAt <= ROOM_TTL_MS) continue;
    rooms.delete(id);
    const dir = path.join(receivedRoot, id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
