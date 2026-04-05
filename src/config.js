/**
 * Personal site settings — edit values below.
 *
 * | Setting           | Purpose |
 * |-------------------|----------------------------------------------------------|
 * | publicUrl         | Optional https://your-app.com (no trailing slash). Leave '' — not needed for a single-page drop. |
 * | fileTtlMinutes    | Data older than this is removed (MongoDB TTL + GridFS purge). Default 60 = 1 hour. |
 * | uploadSecret      | If non-empty, uploads require header X-Upload-Token with this value. Downloads stay open. Leave '' for no upload password. |
 * | trustProxy        | 1 = trust X-Forwarded-* behind HTTPS reverse proxies. 0 if not behind a proxy. |
 * | port              | HTTP port; hosts often set process.env.PORT (see below). |
 */

/** @type {string} */
export const publicUrl = '';

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
