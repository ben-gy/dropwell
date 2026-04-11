/**
 * URL hash-based routing for Dropwell.
 *
 * Scheme: https://dropwell.example/#<base64url(magnetURI)>!<keyHex>
 *
 * The fragment (everything after "#") is never sent to any server — this is
 * a browser guarantee. That's what lets us embed the decryption key in the
 * link without exposing it to GitHub Pages, DNS, or anybody watching HTTP
 * traffic between the user and the origin.
 */

export interface ShareUrlParts {
  magnetURI: string;
  keyHex: string;
}

/** Build a full share URL from a magnet URI and a hex key. */
export function buildShareUrl(magnetURI: string, keyHex: string, origin?: string): string {
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '');
  const encodedMagnet = base64UrlEncode(magnetURI);
  return `${base}#${encodedMagnet}!${keyHex}`;
}

/** Parse the current window.location.hash — or an explicit hash string — into parts. */
export function parseShareUrl(hash?: string): ShareUrlParts | null {
  const raw = hash ?? (typeof window !== 'undefined' ? window.location.hash : '');
  if (!raw || raw.length < 2) return null;
  const payload = raw.startsWith('#') ? raw.slice(1) : raw;
  const sep = payload.lastIndexOf('!');
  if (sep <= 0 || sep === payload.length - 1) return null;

  const encodedMagnet = payload.slice(0, sep);
  const keyHex = payload.slice(sep + 1);

  // Validate the key hex — must be exactly 64 hex chars (256 bits).
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) return null;

  let magnetURI: string;
  try {
    magnetURI = base64UrlDecode(encodedMagnet);
  } catch {
    return null;
  }
  if (!magnetURI.startsWith('magnet:')) return null;

  return { magnetURI, keyHex };
}

/** Returns true when the current URL contains a valid share payload. */
export function isReceiveMode(): boolean {
  return parseShareUrl() !== null;
}

// ---------- base64url helpers ----------

export function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
