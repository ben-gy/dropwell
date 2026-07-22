// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * Client-side encryption for Dropwell.
 *
 * Uses the Web Crypto API — AES-GCM with 256-bit keys.
 * Keys are generated in-browser, exported as hex, and embedded in the
 * URL fragment (#) so they never touch any server.
 *
 * Wire format of an encrypted blob:
 *   [IV  (12 bytes)]
 *   [NAME_LEN (2 bytes, big-endian u16)]
 *   [NAME (UTF-8, NAME_LEN bytes)]
 *   [CIPHERTEXT (remaining bytes — AES-GCM output including auth tag)]
 */

const IV_BYTES = 12;
const KEY_BITS = 256;
const ALGO = 'AES-GCM';

export interface GeneratedKey {
  key: CryptoKey;
  hex: string;
}

/** Generate a fresh 256-bit AES-GCM key and return its hex representation. */
export async function generateKey(): Promise<GeneratedKey> {
  const key = await crypto.subtle.generateKey(
    { name: ALGO, length: KEY_BITS },
    true,
    ['encrypt', 'decrypt'],
  );
  const raw = await crypto.subtle.exportKey('raw', key);
  return { key, hex: bytesToHex(new Uint8Array(raw)) };
}

/** Reconstruct a CryptoKey from its hex representation. */
export async function importKey(hex: string): Promise<CryptoKey> {
  const bytes = hexToBytes(hex);
  if (bytes.length !== KEY_BITS / 8) {
    throw new Error(`Invalid key length: expected ${KEY_BITS / 8} bytes, got ${bytes.length}`);
  }
  return crypto.subtle.importKey('raw', bytes as BufferSource, { name: ALGO }, true, ['encrypt', 'decrypt']);
}

/**
 * Encrypt a file. Produces a new File (named "drop.enc") containing:
 *   IV || NAME_LEN || NAME || CIPHERTEXT
 */
export async function encryptFile(file: File, key: CryptoKey): Promise<File> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const nameBytes = new TextEncoder().encode(file.name);
  if (nameBytes.length > 0xffff) {
    throw new Error('Filename too long');
  }
  const plaintext = await file.arrayBuffer();
  const cipherBuf = await crypto.subtle.encrypt(
    { name: ALGO, iv: iv as BufferSource },
    key,
    plaintext,
  );
  const cipher = new Uint8Array(cipherBuf);

  const out = new Uint8Array(IV_BYTES + 2 + nameBytes.length + cipher.length);
  let offset = 0;
  out.set(iv, offset);
  offset += IV_BYTES;
  out[offset++] = (nameBytes.length >> 8) & 0xff;
  out[offset++] = nameBytes.length & 0xff;
  out.set(nameBytes, offset);
  offset += nameBytes.length;
  out.set(cipher, offset);

  return new File([out], 'drop.enc', { type: 'application/octet-stream' });
}

export interface DecryptedResult {
  name: string;
  blob: Blob;
}

/** Unpack and decrypt an encrypted payload back into { name, blob }. */
export async function decryptBlob(buffer: ArrayBuffer, key: CryptoKey): Promise<DecryptedResult> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < IV_BYTES + 2) {
    throw new Error('Ciphertext too short');
  }
  const iv = bytes.slice(0, IV_BYTES);
  const nameLen = (bytes[IV_BYTES] << 8) | bytes[IV_BYTES + 1];
  const nameStart = IV_BYTES + 2;
  const cipherStart = nameStart + nameLen;
  if (bytes.length < cipherStart) {
    throw new Error('Ciphertext too short for declared filename length');
  }
  const name = new TextDecoder().decode(bytes.slice(nameStart, cipherStart));
  const cipher = bytes.slice(cipherStart);

  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: ALGO, iv: iv as BufferSource },
      key,
      cipher as BufferSource,
    );
  } catch {
    throw new Error('Decryption failed — wrong key or corrupted data');
  }
  return { name, blob: new Blob([plain]) };
}

// ---------- hex helpers ----------

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('Invalid hex character');
    out[i] = byte;
  }
  return out;
}
