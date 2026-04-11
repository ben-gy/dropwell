/**
 * Dropwell entry point.
 *
 * Decides between send and receive mode based on the URL fragment, then
 * wires up the UI to the crypto + torrent modules. All state is driven by
 * real-time handlers coming from the torrent wrapper.
 */

import './styles/main.css';
import { generateKey, importKey, encryptFile, decryptBlob } from './crypto';
import {
  createClient,
  seedFile,
  downloadFile,
  destroyClient,
  type PeerInfo,
  type TrackerInfo,
} from './torrent';
import { buildShareUrl, parseShareUrl } from './router';
import {
  clear,
  createLog,
  formatBytes,
  formatSpeed,
  formatSeconds,
  h,
  icon,
  initModalTriggers,
  mount,
  toast,
} from './ui';

// ---------- top-level app lifecycle ----------

const app = mount();
const client = createClient();

initModalTriggers();

window.addEventListener('beforeunload', () => destroyClient(client));

const share = parseShareUrl();
if (share) {
  renderReceive(share.magnetURI, share.keyHex).catch((err) => {
    console.error(err);
    renderReceiveError(err instanceof Error ? err.message : String(err));
  });
} else {
  renderIdle();
}

// ====================================================================
//  SEND MODE
// ====================================================================

function renderIdle(): void {
  clear(app);

  const hero = h(
    'section',
    { class: 'hero' },
    h(
      'h1',
      {},
      'encrypted p2p file drops',
      h('span', { class: 'cursor', 'aria-hidden': 'true' }),
    ),
    h(
      'p',
      { class: 'tagline' },
      'Drop a file. Get a link. Share it. Files are encrypted in your browser and streamed ',
      h('strong', {}, 'peer-to-peer'),
      ' — never stored on any server.',
    ),
  );

  const input = h('input', {
    type: 'file',
    id: 'file-input',
    'aria-label': 'Choose a file to share',
  }) as HTMLInputElement;

  const dropzone = h(
    'div',
    {
      class: 'dropzone',
      role: 'button',
      tabindex: '0',
      'aria-label': 'Drop a file here or click to browse',
    },
    icon('upload', 'dropzone-icon'),
    h('h2', {}, 'drop file to encrypt & share'),
    h(
      'p',
      {},
      'or click to browse — encrypted locally, streamed via webrtc, never touches a server',
    ),
    h('span', { class: 'browse' }, '> select file'),
    input,
  );

  dropzone.addEventListener('click', (e) => {
    if (e.target === input) return;
    input.click();
  });
  dropzone.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' || ke.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });

  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) void handleFile(f);
  });

  // Page-level drag handling to prevent the browser from opening dropped files.
  window.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault();
    dropzone.classList.add('is-dragging');
  });
  window.addEventListener('dragleave', (e: DragEvent) => {
    e.preventDefault();
    if (e.target === dropzone) dropzone.classList.remove('is-dragging');
  });
  window.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragging');
    const f = e.dataTransfer?.files?.[0];
    if (f) void handleFile(f);
  });

  // Below the dropzone: a row of security badges for trust.
  const badges = h(
    'div',
    { class: 'security-badges', 'aria-label': 'Security features' },
    secBadge('lock', 'aes-gcm-256'),
    secBadge('lock', 'key never leaves browser'),
    secBadge('info', 'zero backend'),
    secBadge('info', 'webrtc peer-to-peer'),
    secBadge('info', 'no tracking'),
  );

  app.appendChild(hero);
  app.appendChild(dropzone);
  app.appendChild(badges);
}

async function handleFile(file: File): Promise<void> {
  try {
    renderEncrypting(file);
    const { key, hex } = await generateKey();
    // Let the progress frame paint before we block on encryption for big files.
    await new Promise((r) => setTimeout(r, 50));
    const encrypted = await encryptFile(file, key);
    await renderSeeding(file, encrypted, hex);
  } catch (err) {
    console.error(err);
    renderSendError(err instanceof Error ? err.message : String(err));
  }
}

function renderEncrypting(file: File): void {
  clear(app);
  const panel = h(
    'section',
    { class: 'panel' },
    h('h2', {}, h('span', { class: 'dot' }), 'encrypting locally...'),
    fileMeta(file),
    h('div', { class: 'progress progress-indeterminate' }, h('div', { class: 'progress-fill' })),
    h(
      'div',
      { class: 'banner banner-info' },
      icon('lock', 'icon'),
      h(
        'p',
        {},
        'Generating a fresh AES-GCM-256 key in your browser and encrypting the file. The key will only ever live in this tab and in the URL fragment.',
      ),
    ),
  );
  app.appendChild(panel);
}

async function renderSeeding(originalFile: File, encryptedFile: File, keyHex: string): Promise<void> {
  clear(app);

  const panel = h('section', { class: 'panel' });
  panel.appendChild(h('h2', {}, h('span', { class: 'dot' }), 'seeding — keep this tab open'));

  // Security badges up front — these visibly confirm the protection in place.
  panel.appendChild(
    h(
      'div',
      { class: 'security-badges' },
      secBadge('lock', 'aes-gcm-256 ✓'),
      secBadge('lock', `key fingerprint ${fingerprint(keyHex)}`),
      secBadge('info', 'e2e encrypted'),
      secBadge('info', 'p2p via webrtc'),
    ),
  );

  panel.appendChild(fileMeta(originalFile));

  // Key ribbon — gives users visible proof their key exists and is never
  // uploaded (it lives in the URL fragment only).
  panel.appendChild(
    h(
      'div',
      { class: 'key-ribbon' },
      icon('lock'),
      h('span', { class: 'label' }, 'your encryption key (stays in-browser):'),
      h('span', { class: 'fp' }, fingerprint(keyHex)),
    ),
  );

  const linkInput = h('input', {
    type: 'text',
    readonly: '',
    value: 'starting webtorrent swarm...',
    'aria-label': 'Share URL',
  }) as HTMLInputElement;
  const copyBtn = h('button', { class: 'primary', disabled: '' }, 'copy link');
  const shareBtn = h('button', { class: 'ghost', disabled: '' }, 'share');
  const newBtn = h('button', { class: 'ghost' }, 'drop another');

  panel.appendChild(h('div', { class: 'share-url' }, linkInput, copyBtn));
  panel.appendChild(h('div', { class: 'share-actions' }, shareBtn, newBtn));

  const peerStat = statBox('peers', '0');
  const uploadedStat = statBox('uploaded', '0 B');
  const speedStat = statBox('up speed', '0 B/s');
  const ratioStat = statBox('ratio', '0.00');
  panel.appendChild(h('div', { class: 'stats' }, peerStat, uploadedStat, speedStat, ratioStat));

  // Live peer + tracker lists
  const peerList = h('ul', { class: 'live-list' }, emptyLi('no peers connected yet'));
  const trackerList = h('ul', { class: 'live-list' }, emptyLi('announcing to trackers...'));
  const peerCount = h('span', { class: 'count' }, '0');
  const trackerCount = h('span', { class: 'count' }, '0');

  panel.appendChild(
    h(
      'div',
      { class: 'live-grid' },
      liveCard('connected peers', peerCount, peerList),
      liveCard('trackers', trackerCount, trackerList),
    ),
  );

  panel.appendChild(
    h(
      'div',
      { class: 'banner banner-warn' },
      icon('warn', 'icon'),
      h(
        'p',
        {},
        h('strong', {}, 'keep this tab open. '),
        'Your browser is the seed — if you close it, the file disappears from the network.',
      ),
    ),
  );

  const logPanel = h('div');
  panel.appendChild(logPanel);
  const { log } = createLog(logPanel);

  app.appendChild(panel);

  log(`encrypted ${encryptedFile.size.toLocaleString()} bytes (AES-GCM-256)`, 'ok');
  log(`key fingerprint: ${fingerprint(keyHex)}`, 'ok');
  log('joining swarm...');

  const { magnetURI, infoHash } = await seedFile(client, encryptedFile, {
    onProgress: (info) => {
      peerStat.querySelector('.value')!.textContent = String(info.numPeers);
      uploadedStat.querySelector('.value')!.textContent = formatBytes(info.uploaded);
      speedStat.querySelector('.value')!.textContent = formatSpeed(info.uploadSpeed);
      ratioStat.querySelector('.value')!.textContent = info.ratio.toFixed(2);
      peerCount.textContent = String(info.numPeers);
    },
    onPeer: (peers) => renderPeerList(peerList, peers),
    onTrackers: (trackers) => {
      renderTrackerList(trackerList, trackers);
      trackerCount.textContent = String(
        trackers.filter((t) => t.status === 'connected').length,
      );
    },
    onLog: (m, k) => log(m, k),
    onError: (err) => log(`error: ${err.message}`, 'err'),
  });

  const shareUrl = buildShareUrl(magnetURI, keyHex);
  linkInput.value = shareUrl;
  copyBtn.removeAttribute('disabled');
  log(`magnet ready · infohash: ${infoHash}`, 'ok');
  log('waiting for peers to connect...');

  panel.querySelector('.dot')?.classList.add('good');

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast('link copied');
    } catch {
      linkInput.select();
      document.execCommand('copy');
      toast('link copied');
    }
  });

  if ('share' in navigator) {
    shareBtn.removeAttribute('disabled');
    shareBtn.addEventListener('click', async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (navigator as any).share({
          title: 'Dropwell',
          text: 'Encrypted file drop',
          url: shareUrl,
        });
      } catch {
        /* user cancelled */
      }
    });
  }

  newBtn.addEventListener('click', () => {
    // Open a fresh tab so the current seed keeps running.
    window.open(window.location.origin + window.location.pathname, '_blank');
  });
}

function renderSendError(msg: string): void {
  clear(app);
  app.appendChild(
    h(
      'section',
      { class: 'panel' },
      h('h2', {}, h('span', { class: 'dot bad' }), 'something broke'),
      h(
        'div',
        { class: 'banner banner-error' },
        icon('warn', 'icon'),
        h('p', {}, msg),
      ),
      h(
        'div',
        { class: 'share-actions' },
        h('button', { class: 'primary', id: 'retry-send' }, 'try again'),
      ),
    ),
  );
  document.getElementById('retry-send')?.addEventListener('click', () => renderIdle());
}

// ====================================================================
//  RECEIVE MODE
// ====================================================================

async function renderReceive(magnetURI: string, keyHex: string): Promise<void> {
  clear(app);

  const panel = h('section', { class: 'panel' });
  panel.appendChild(h('h2', {}, h('span', { class: 'dot' }), 'receiving encrypted drop'));

  panel.appendChild(
    h(
      'div',
      { class: 'security-badges' },
      secBadge('lock', 'aes-gcm-256'),
      secBadge('lock', `key fingerprint ${fingerprint(keyHex)}`),
      secBadge('info', 'decrypt-on-device'),
      secBadge('info', 'p2p via webrtc'),
    ),
  );

  panel.appendChild(
    h(
      'div',
      { class: 'banner banner-info' },
      icon('info', 'icon'),
      h(
        'p',
        {},
        'Connecting to the sender via WebRTC. The ciphertext is streamed peer-to-peer and decrypted locally once the transfer is complete — the sender\'s key came from the URL fragment you just opened.',
      ),
    ),
  );

  const progressBar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  panel.appendChild(progressBar);

  const peerStat = statBox('peers', '0');
  const progressStat = statBox('progress', '0%');
  const speedStat = statBox('down speed', '0 B/s');
  const sizeStat = statBox('downloaded', '0 B');
  const etaStat = statBox('eta', '—');
  panel.appendChild(h('div', { class: 'stats' }, peerStat, progressStat, speedStat, sizeStat, etaStat));

  const peerList = h('ul', { class: 'live-list' }, emptyLi('searching for peers...'));
  const trackerList = h('ul', { class: 'live-list' }, emptyLi('announcing to trackers...'));
  const peerCount = h('span', { class: 'count' }, '0');
  const trackerCount = h('span', { class: 'count' }, '0');

  panel.appendChild(
    h(
      'div',
      { class: 'live-grid' },
      liveCard('connected peers', peerCount, peerList),
      liveCard('trackers', trackerCount, trackerList),
    ),
  );

  const logPanel = h('div');
  panel.appendChild(logPanel);
  const { log } = createLog(logPanel);

  app.appendChild(panel);

  log('parsed share URL');
  log(`infohash: ${magnetURI.match(/btih:([a-f0-9]+)/i)?.[1] ?? '?'}`);
  log(`key fingerprint: ${fingerprint(keyHex)}`, 'ok');
  log('joining swarm, waiting for peers...');

  const key = await importKey(keyHex);

  const result = await downloadFile(client, magnetURI, {
    onProgress: (info) => {
      (progressBar.firstElementChild as HTMLElement).style.width = `${info.percent.toFixed(1)}%`;
      progressStat.querySelector('.value')!.textContent = `${info.percent.toFixed(0)}%`;
      speedStat.querySelector('.value')!.textContent = formatSpeed(info.downloadSpeed);
      sizeStat.querySelector('.value')!.textContent = formatBytes(info.downloaded);
      peerStat.querySelector('.value')!.textContent = String(info.numPeers);
      peerCount.textContent = String(info.numPeers);
      etaStat.querySelector('.value')!.textContent = formatSeconds(info.timeRemaining / 1000);
    },
    onPeer: (peers) => renderPeerList(peerList, peers),
    onTrackers: (trackers) => {
      renderTrackerList(trackerList, trackers);
      trackerCount.textContent = String(
        trackers.filter((t) => t.status === 'connected').length,
      );
    },
    onLog: (m, k) => log(m, k),
    onError: (err) => log(`error: ${err.message}`, 'err'),
  });

  log('download complete, decrypting in-browser...', 'ok');
  panel.querySelector('.dot')?.classList.add('good');

  const buffer = await result.blob.arrayBuffer();
  const { name, blob } = await decryptBlob(buffer, key);

  log(`decrypted: ${name} (${formatBytes(blob.size)})`, 'ok');

  renderReceiveComplete(name, blob);
}

function renderReceiveComplete(name: string, blob: Blob): void {
  clear(app);

  const url = URL.createObjectURL(blob);
  const panel = h(
    'section',
    { class: 'panel' },
    h('h2', {}, h('span', { class: 'dot good' }), 'decryption successful'),
    h(
      'div',
      { class: 'security-badges' },
      secBadge('lock', 'aes-gcm-256 verified'),
      secBadge('info', 'integrity check passed'),
    ),
    h(
      'div',
      { class: 'complete-hero' },
      icon('check', 'check'),
      h('h3', {}, name),
      h('p', {}, `${formatBytes(blob.size)} · decrypted locally`),
      (() => {
        const dl = h(
          'a',
          { class: 'btn primary', href: url, download: name, role: 'button' },
          'save file',
        );
        dl.addEventListener('click', () => {
          setTimeout(() => URL.revokeObjectURL(url), 3000);
        });
        return dl;
      })(),
    ),
    h(
      'div',
      { class: 'banner banner-info' },
      icon('info', 'icon'),
      h(
        'p',
        {},
        'The sender can close their tab once you\'ve saved the file. ',
        h('a', { href: window.location.origin + window.location.pathname }, 'drop your own file'),
        '.',
      ),
    ),
  );
  app.appendChild(panel);
}

function renderReceiveError(msg: string): void {
  clear(app);
  app.appendChild(
    h(
      'section',
      { class: 'panel' },
      h('h2', {}, h('span', { class: 'dot bad' }), 'receive failed'),
      h(
        'div',
        { class: 'banner banner-error' },
        icon('warn', 'icon'),
        h('p', {}, msg),
      ),
      h(
        'p',
        { style: 'color: var(--fg-2); font-size: 13px; margin-top: 16px;' },
        'Common causes: the sender closed their browser tab, a firewall is blocking WebRTC, or the link was altered in transit.',
      ),
      h(
        'div',
        { class: 'share-actions' },
        h(
          'a',
          { class: 'btn', href: window.location.origin + window.location.pathname },
          'drop your own file',
        ),
      ),
    ),
  );
}

// ====================================================================
//  small view helpers
// ====================================================================

function fileMeta(file: File): HTMLElement {
  return h(
    'div',
    { class: 'file-meta' },
    icon('file', 'file-icon'),
    h('div', { class: 'file-name' }, file.name),
    h('div', { class: 'file-size' }, formatBytes(file.size)),
  );
}

function statBox(label: string, value: string): HTMLElement {
  return h(
    'div',
    { class: 'stat' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
  );
}

function secBadge(iconName: 'lock' | 'info', label: string): HTMLElement {
  return h('span', { class: 'sec-badge' }, icon(iconName), h('span', {}, label));
}

function liveCard(title: string, count: HTMLElement, list: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'live-card' },
    h('div', { class: 'live-card-head' }, h('span', {}, title), count),
    list,
  );
}

function emptyLi(msg: string): HTMLElement {
  return h('li', { class: 'empty' }, msg);
}

function renderPeerList(ul: HTMLElement, peers: PeerInfo[]): void {
  while (ul.firstChild) ul.removeChild(ul.firstChild);
  if (!peers.length) {
    ul.appendChild(emptyLi('no peers connected yet'));
    return;
  }
  for (const p of peers) {
    ul.appendChild(
      h(
        'li',
        {},
        h('span', { class: 'dot-small connected' }),
        h('span', { class: 'main' }, p.addr || p.type),
        h('span', { class: 'sub' }, `↑${formatBytes(p.uploaded)} ↓${formatBytes(p.downloaded)}`),
      ),
    );
  }
}

function renderTrackerList(ul: HTMLElement, trackers: TrackerInfo[]): void {
  while (ul.firstChild) ul.removeChild(ul.firstChild);
  if (!trackers.length) {
    ul.appendChild(emptyLi('no trackers configured'));
    return;
  }
  for (const t of trackers) {
    const short = t.url.replace(/^wss?:\/\//, '').replace(/\/.*/, '');
    ul.appendChild(
      h(
        'li',
        {},
        h('span', { class: `dot-small ${t.status}` }),
        h('span', { class: 'main' }, short),
        h('span', { class: 'sub' }, t.status),
      ),
    );
  }
}

/** First and last 4 chars of the hex key — enough to compare visually. */
function fingerprint(hex: string): string {
  if (hex.length < 10) return hex;
  return `${hex.slice(0, 4)}…${hex.slice(-4)}`;
}
