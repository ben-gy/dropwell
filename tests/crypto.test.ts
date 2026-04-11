/**
 * @vitest-environment node
 *
 * Running under the Node environment — Node 20+ ships native File, Blob,
 * and webcrypto.subtle, so the tests exercise the same code paths as the
 * browser without any jsdom polyfill dance.
 */

import { describe, expect, it } from 'vitest';

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
  return new File([data], name, { type: 'application/octet-stream' });
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

    const { name, blob } = await decryptBlob(await encrypted.arrayBuffer(), key);
    expect(name).toBe('hello.txt');
    expect(await blob.text()).toBe('hello dropwell');
  });

  it('round-trips an empty file', async () => {
    const original = makeFile('empty.bin', new Uint8Array());
    const { key } = await generateKey();
    const encrypted = await encryptFile(original, key);
    const { name, blob } = await decryptBlob(await encrypted.arrayBuffer(), key);
    expect(name).toBe('empty.bin');
    expect(blob.size).toBe(0);
  });

  it('round-trips a unicode filename', async () => {
    const unicodeName = '📎 déjà vu — 日本語.txt';
    const original = makeFile(unicodeName, 'unicode!');
    const { key } = await generateKey();
    const encrypted = await encryptFile(original, key);
    const { name, blob } = await decryptBlob(await encrypted.arrayBuffer(), key);
    expect(name).toBe(unicodeName);
    expect(await blob.text()).toBe('unicode!');
  });

  it('round-trips a 1MB binary payload', async () => {
    const buf = new Uint8Array(1024 * 1024);
    for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;
    const original = makeFile('big.bin', buf);
    const { key } = await generateKey();
    const encrypted = await encryptFile(original, key);
    const { name, blob } = await decryptBlob(await encrypted.arrayBuffer(), key);
    expect(name).toBe('big.bin');
    const out = new Uint8Array(await blob.arrayBuffer());
    expect(out.length).toBe(buf.length);
    // Spot-check rather than comparing the whole array (fast).
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
    await expect(decryptBlob(await encrypted.arrayBuffer(), key2)).rejects.toThrow();
  });
});
