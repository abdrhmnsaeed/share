/**
 * Personal site settings — edit values below.
 *
 * | Setting           | Purpose |
 * |-------------------|----------------------------------------------------------|
 * | publicUrl         | Optional https://your-app.com (no trailing slash). Leave '' — not needed for a single-page drop. |
 * | fileTtlMinutes    | Files and text pastes older than this are deleted from the server (default 60). |
 * | uploadSecret      | If non-empty, uploads require header X-Upload-Token with this value. Downloads stay open. Leave '' for no upload password. |
 * | trustProxy        | 1 = trust X-Forwarded-* behind HTTPS reverse proxies. 0 if not behind a proxy. |
 * | port              | HTTP port; hosts often set process.env.PORT (see below). |
 * | receivedDir       | Absolute path for uploads. Leave '' — server picks project `received/` locally, or OS temp on Vercel (read-only filesystem). Override with env RECEIVED_DIR. |
 */

/** @type {string} */
export const publicUrl = '';

/**
 * Fixed absolute path for uploads, or '' for automatic:
 * - Local: ./received next to the project
 * - Vercel: OS temp (e.g. /tmp/drop-received) — deploy bundle is read-only
 * @type {string}
 */
export const receivedDir = '';

/** @type {number} */
export const fileTtlMinutes = 60;

/** @type {string} */
export const uploadSecret = '';

/** @type {number} */
export const trustProxy = 1;

/**
 * Listen port: default 8742. Many hosts inject process.env.PORT.
 * @type {number}
 */
export const port = Number(process.env.PORT) || 8742;
