/**
 * Personal site settings — edit values below (no separate .env needed).
 *
 * | Setting            | Purpose |
 * |--------------------|----------------------------------------------------------|
 * | publicUrl          | https://your-app.com — correct QR/join links when hosted (no trailing slash). Leave '' to build URLs from each request (Host / proto). |
 * | roomTtlMinutes     | Room + files deleted after this many minutes (default 60). |
 * | createRoomSecret   | If non-empty, POST /api/rooms requires header X-Create-Token with this value. If '', anyone can create a room. |
 * | trustProxy         | 1 = trust X-Forwarded-Proto / X-Forwarded-Host behind HTTPS reverse proxies. Use 0 when not behind a proxy. |
 * | port               | HTTP listen port when running locally (see port line below for hosted overrides). |
 */

/** @type {string} */
export const publicUrl = '';

/** @type {number} */
export const roomTtlMinutes = 60;

/** @type {string} */
export const createRoomSecret = '';

/** @type {number} */
export const trustProxy = 1;

/**
 * Listen port: default 8742. Many hosts inject process.env.PORT — we honor it when set.
 * @type {number}
 */
export const port = Number(process.env.PORT) || 8742;
