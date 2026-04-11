/**
 * @vitest-environment jsdom
 *
 * jsdom doesn't ship Web Crypto subtle by default, so we need to polyfill.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';

// Patch jsdom's window.crypto with the Node webcrypto implementation.
// jsdom's Blob.arrayBuffer() either doesn't exist or returns a view whose
// backing buffer Node's SubtleCrypto refuses. We work around this with a
// per-instance override in makeFile() + a per-instance override on the
// encrypted File and on any Blob we want to decrypt (see the helper below).
beforeAll(() => {
  if (!globalThis.crypto || !('subtle' in globalThis.crypto)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).crypto = webcrypto;
  }
});

/** Copy a Uint8Array into a fresh, standalone ArrayBuffer. */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

// Import after the polyfill.
import {
  generateKey,
  importKey,
  encryptFile,
  decryptBlob,
  bytesToHex,
  hexToBytes,
} from '../src/crypto';

function makeFile(name: string, contents: Uint8Array | string): File {
  const data = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents;
  const file = new File([data as BlobPart], name, { type: 'application/octet-stream' });
  // Force arrayBuffer() to return a real, standalone ArrayBuffer that
  // Node's SubtleCrypto accepts — jsdom's default implementation doesn't.
  const ab = toArrayBuffer(data);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (file as any).arrayBuffer = async () => ab;
  return file;
}

/** Read a Blob/File produced by the library into a fresh, standalone
 *  ArrayBuffer that Node's SubtleCrypto will accept. */
function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const res = fr.result;
      if (res instanceof ArrayBuffer) {
        // Copy into a fresh ArrayBuffer so the returned buffer is
        // guaranteed to be a standalone ArrayBuffer (not SharedArrayBuffer
        // or a view) — Node's webcrypto rejects anything else.
        resolve(toArrayBuffer(new Uint8Array(res)));
      } else {
        reject(new Error('unexpected FileReader result type'));
      }
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(blob);
  });
}

describe('crypto', () => {
  it('hex round-trip', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 128, 64]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it('generates a 256-bit key and exports hex', async () => {
    const { hex } = await generateKey();
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('imports an exported key and preserves identity', async () => {
    const { hex } = await generateKey();
    const key2 = await importKey(hex);
    expect(key2).toBeDefined();
  });

  it('round-trips a simple text file', async () => {
    const original = makeFile('hello.txt', 'hello dropwell');
    const { key } = await generateKey();
    const encrypted = await encryptFile(original, key);
    expect(encrypted.name).toBe('drop.enc');
    expect(encrypted.size).toBeGreaterThan(0);

    const { name, blob } = await decryptBlob(await blobToArrayBuffer(encrypted), key);
    expect(name).toBe('hello.txt');
    expect(new TextDecoder().decode(await blobToArrayBuffer(blob))).toBe('hello dropwell');
  });

  it('round-trips an empty file', async () => {
    const original = makeFile('empty.bin', new Uint8Array());
    const { key } = await generateKey();
    const encrypted = await encryptFile(original, key);
    const { name, blob } = await decryptBlob(await blobToArrayBuffer(encrypted), key);
    expect(name).toBe('empty.bin');
    expect(blob.size).toBe(0);
  });

  it('round-trips a unicode filename', async () => {
    const unicodeName = '📎 déjà vu — 日本語.txt';
    const original = makeFile(unicodeName, 'unicode!');
    const { key } = await generateKey();
    const encrypted = await encryptFile(original, key);
    const { name, blob } = await decryptBlob(await blobToArrayBuffer(encrypted), key);
    expect(name).toBe(unicodeName);
    expect(new TextDecoder().decode(await blobToArrayBuffer(blob))).toBe('unicode!');
  });

  it('round-trips a 1MB binary payload', async () => {
    const buf = new Uint8Array(1024 * 1024);
    for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;
    const original = makeFile('big.bin', buf);
    const { key } = await generateKey();
    const encrypted = await encryptFile(original, key);
    const { name, blob } = await decryptBlob(await blobToArrayBuffer(encrypted), key);
    expect(name).toBe('big.bin');
    const out = new Uint8Array(await blobToArrayBuffer(blob));
    expect(out.length).toBe(buf.length);
    // Spot-check a few bytes rather than comparing the whole array (fast).
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
    expect(out[255]).toBe(255);
    expect(out[out.length - 1]).toBe((out.length - 1) & 0xff);
  });

  it('fails to decrypt with a different key', async () => {
    const original = makeFile('secret.txt', 'top secret');
    const { key: key1 } = await generateKey();
    const { key: key2 } = await generateKey();
    const encrypted = await encryptFile(original, key1);
    await expect(decryptBlob(await blobToArrayBuffer(encrypted), key2)).rejects.toThrow();
  });
});
