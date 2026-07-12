# dropwell

**Encrypted peer-to-peer file sharing in the browser. Drop a file, get a link, share it. No backend, no installs.**

Live: https://dropwell.benrichardson.dev

---

## what it is

Dropwell is a single static site that lets you send a file to somebody else
with **end-to-end encryption** and **zero backend**. The file is:

1. encrypted **in your browser** with a fresh AES-GCM-256 key,
2. seeded via **WebTorrent** (WebRTC) directly from your tab,
3. shared as a URL whose fragment (`#...`) contains both the magnet link and
   the decryption key.

The recipient opens the link, joins the torrent swarm, downloads the
ciphertext peer-to-peer, and decrypts it in-browser. **No file, and no key,
ever touches a server.**

## how it works

```
┌──────────── SENDER ────────────┐            ┌──────────── RECEIVER ──────────┐
│                                │            │                                │
│  file ──► AES-GCM encrypt ─┐   │            │   parse URL#magnet!key         │
│                            ▼   │   webrtc   │            │                   │
│                  WebTorrent seed ───────────► WebTorrent download            │
│                            │   │            │            │                   │
│                 share URL #magnet!keyHex    │            ▼                   │
│                            │   │            │    AES-GCM decrypt ──► file   │
└────────────────────────────┼───┘            └────────────────────────────────┘
                             │
                             ▼
                      clipboard / QR / native share sheet
```

The only external connections are to WebTorrent tracker servers for peer
discovery:

- `wss://tracker.openwebtorrent.com`
- `wss://tracker.webtorrent.dev`
- `wss://tracker.btorrent.xyz`

These see peer IPs and infohashes — **never file contents, filenames, or
keys**.

## wire format

The encrypted payload that gets seeded is:

```
[IV (12 bytes)] [NAME_LEN (u16 BE)] [NAME (UTF-8)] [CIPHERTEXT]
```

The decryption key and the magnet URI are combined into the URL as:

```
https://dropwell.benrichardson.dev/#<base64url(magnetURI)>!<keyHex>
```

Browsers never send anything after `#` over the network, so GitHub Pages,
DNS, and any proxy between you and the origin see only the path. The key
stays local.

## security model

**Protected**
- File contents (AES-GCM-256 authenticated encryption).
- Original filename (encoded inside the ciphertext).
- The decryption key (never leaves the URL fragment).

**Not protected**
- The *size* of the encrypted blob — visible to trackers and swarm peers.
- IP addresses of sender and receiver — inherent to BitTorrent.
- The fact that a transfer happened — trackers see the infohash.

**Trust model**
- Sender and receiver must trust each other.
- The link **is** the secret — anyone with the full link can decrypt.
- If the sender's tab is closed before the receiver finishes downloading,
  the file is gone.

## stack

- **Vite 6** + vanilla TypeScript (no framework)
- **WebTorrent** for P2P transfer over WebRTC
- **Web Crypto API** for AES-GCM encryption
- **Vitest** for unit tests
- **GitHub Pages** for hosting, deployed via GitHub Actions

No runtime dependencies beyond WebTorrent. No cookies, no fingerprinting, no
third-party fonts. The only analytics is Cloudflare Web Analytics — anonymous,
cookie-less page-view counts; no personal data, no cross-site tracking.

## local development

```bash
npm install
npm run dev      # vite dev server on :5173
npm test         # run vitest suite
npm run build    # produce dist/ for deploy
npm run preview  # serve dist/ locally
```

### manual QA flow

To actually verify an end-to-end drop works, you need two browser tabs:

1. `npm run dev`, open http://localhost:5173 in **tab A**.
2. Drop a file into the dropzone. Copy the generated link.
3. Open the link in **tab B** (different profile/incognito is fine).
4. Verify the downloaded file matches the original (filename + contents).

Test with a small text file, a large image, and a PDF.

## deploying

A push to `main` triggers `.github/workflows/deploy.yml`, which runs tests,
builds, and deploys `dist/` to GitHub Pages. The custom domain is set via
`public/CNAME` — point a `CNAME` DNS record for `dropwell.benrichardson.dev`
at `ben-gy.github.io`.

## license

MIT — see [LICENSE](./LICENSE).
