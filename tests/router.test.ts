/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  buildShareUrl,
  parseShareUrl,
} from '../src/router';

const MAGNET =
  'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=drop.enc&tr=wss%3A%2F%2Ftracker.openwebtorrent.com';
const KEY_HEX = 'a'.repeat(64);

describe('router', () => {
  it('base64url round-trips', () => {
    const s = 'magnet:?xt=urn:btih:abcdef&dn=drop.enc+is+fun';
    expect(base64UrlDecode(base64UrlEncode(s))).toBe(s);
  });

  it('builds a share URL and parses it back', () => {
    const url = buildShareUrl(MAGNET, KEY_HEX, 'https://dropwell.example/');
    expect(url.startsWith('https://dropwell.example/#')).toBe(true);
    const hash = url.slice(url.indexOf('#'));
    const parsed = parseShareUrl(hash);
    expect(parsed).not.toBeNull();
    expect(parsed!.magnetURI).toBe(MAGNET);
    expect(parsed!.keyHex).toBe(KEY_HEX);
  });

  it('returns null for empty hash', () => {
    expect(parseShareUrl('')).toBeNull();
    expect(parseShareUrl('#')).toBeNull();
  });

  it('rejects a hash with no separator', () => {
    expect(parseShareUrl('#abcdef')).toBeNull();
  });

  it('rejects a hash with a bad key length', () => {
    expect(parseShareUrl(`#${base64UrlEncode(MAGNET)}!short`)).toBeNull();
  });

  it('rejects a hash where the encoded part is not a magnet URI', () => {
    const encoded = base64UrlEncode('not-a-magnet');
    expect(parseShareUrl(`#${encoded}!${KEY_HEX}`)).toBeNull();
  });

  it('accepts uppercase hex keys', () => {
    const upper = KEY_HEX.toUpperCase();
    const url = buildShareUrl(MAGNET, upper, 'https://dropwell.example/');
    const parsed = parseShareUrl(url.slice(url.indexOf('#')));
    expect(parsed?.keyHex).toBe(upper);
  });
});
