/**
 * Dropwell entry point.
 *
 * Wires the desktop-app shell: top bar status, main content area,
 * right-side live event drawer, bottom status bar. Decides between send
 * and receive mode based on the URL fragment, then drives the UI from
 * the torrent + crypto modules using real-time event handlers that all
 * route through the central event log.
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
  formatBytes,
  formatSpeed,
  formatSeconds,
  h,
  icon,
  initModalTriggers,
  mount,
  toast,
} from './ui';
import { createNetworkViz } from './network';
import { emit as logEvent, mountEventDrawer } from './eventlog';

// ---------- top-level app lifecycle ----------

const app = mount();
const drawerEl = document.getElementById('event-drawer')!;
mountEventDrawer(drawerEl);

const client = createClient();
initModalTriggers();

logEvent('system', 'ok', 'dropwell ready', { build: 'v0.1', mode: 'idle' });
logEvent('system', 'info', 'webcrypto available', { subtle: 'crypto.subtle' });
logEvent('system', 'info', 'webtorrent client created');

// ---------- session clock ----------
const sessionStart = Date.now();
setInterval(() => {
  const dt = Math.floor((Date.now() - sessionStart) / 1000);
  const m = String(Math.floor(dt / 60)).padStart(2, '0');
  const s = String(dt % 60).padStart(2, '0');
  const el = document.getElementById('sb-clock');
  if (el) el.innerHTML = `<span style="color:var(--fg-3)">t</span> ${m}:${s}`;
}, 1000);

// ---------- beforeunload guard ----------
let unloadGuardActive = false;
function beforeUnloadHandler(e: BeforeUnloadEvent) {
  e.preventDefault();
  // Required by Chrome/Edge
  e.returnValue = '';
  return '';
}
function lockUnload(reason: string): void {
  if (unloadGuardActive) return;
  unloadGuardActive = true;
  window.addEventListener('beforeunload', beforeUnloadHandler);
  logEvent('system', 'warn', `unload guard armed — ${reason}`);
}
function unlockUnload(): void {
  if (!unloadGuardActive) return;
  unloadGuardActive = false;
  window.removeEventListener('beforeunload', beforeUnloadHandler);
  logEvent('system', 'info', 'unload guard released');
}

window.addEventListener('beforeunload', () => destroyClient(client));

// ---------- status bar helpers ----------
function setStatus(state: 'idle' | 'busy' | 'good' | 'warn' | 'bad', label: string): void {
  const dot = document.getElementById('sb-status-dot');
  const lab = document.getElementById('sb-status-label');
  if (dot) {
    dot.className = 'dot-mini ' + (state === 'idle' ? 'idle' : state === 'bad' ? 'bad' : state === 'warn' ? 'warn' : '');
  }
  if (lab) lab.textContent = label;
}
function setStatusMode(mode: string): void {
  const el = document.getElementById('sb-mode');
  if (el) el.innerHTML = mode ? `<span style="color:var(--fg-3)">mode</span> ${mode}` : '';
}
function setStatusPeers(n: number): void {
  const el = document.getElementById('sb-peers');
  if (el) el.innerHTML = `<span style="color:var(--fg-3)">peers</span> ${n}`;
}
function setStatusTrackers(connected: number, total: number): void {
  const el = document.getElementById('sb-trackers');
  if (el) el.innerHTML = `<span style="color:var(--fg-3)">trackers</span> ${connected}/${total}`;
}
function setStatusThroughput(down: number, up: number): void {
  const el = document.getElementById('sb-throughput');
  if (el) {
    const txt = down > 0 || up > 0 ? `↓${formatSpeed(down)} · ↑${formatSpeed(up)}` : '—';
    el.innerHTML = `<span style="color:var(--fg-3)">throughput</span> ${txt}`;
  }
}

// ---------- mode dispatch ----------

const share = parseShareUrl();
if (share) {
  setStatusMode('receive');
  logEvent('ui', 'info', 'parsed share url from fragment', {
    keyHashPrefix: share.keyHex.slice(0, 8),
  });
  renderReceive(share.magnetURI, share.keyHex).catch((err) => {
    console.error(err);
    renderReceiveError(err instanceof Error ? err.message : String(err));
  });
} else {
  setStatusMode('idle');
  renderIdle();
}

// ====================================================================
//  SEND MODE — IDLE
// ====================================================================

function renderIdle(): void {
  clear(app);
  setStatus('idle', 'idle');
  logEvent('ui', 'info', 'render: idle');

  const hero = h(
    'div',
    { class: 'hero-strip' },
    h(
      'h1',
      {},
      'dropwell',
      h('span', { class: 'cursor', 'aria-hidden': 'true' }),
    ),
    h('p', { class: 'tagline' }, '// encrypted peer-to-peer file drops'),
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
    h('p', {}, 'or click to browse · encrypted locally · streamed via webrtc'),
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

  // Page-level drag handling
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

  const features = h(
    'div',
    { class: 'feature-row' },
    featurePill('lock', 'aes-gcm-256'),
    featurePill('lock', 'key in fragment only'),
    featurePill('share', 'webrtc data channels'),
    featurePill('info', 'zero backend / zero tracking'),
  );

  app.appendChild(hero);
  app.appendChild(dropzone);
  app.appendChild(features);
}

async function handleFile(file: File): Promise<void> {
  try {
    logEvent('ui', 'info', 'file selected', { name: file.name, size: file.size });
    renderEncrypting(file);
    setStatus('busy', 'encrypting');
    setStatusMode('encrypt');

    logEvent('crypto', 'info', 'generating aes-gcm-256 key');
    const t0 = performance.now();
    const { key, hex } = await generateKey();
    logEvent('crypto', 'ok', 'key generated', {
      bits: 256,
      ms: Math.round(performance.now() - t0),
      fp: fingerprint(hex),
    });

    // Let the progress frame paint before we block on encryption for big files.
    await new Promise((r) => setTimeout(r, 50));

    logEvent('crypto', 'info', 'encrypting file', { size: file.size });
    const t1 = performance.now();
    const encrypted = await encryptFile(file, key);
    logEvent('crypto', 'ok', 'encryption complete', {
      input: file.size,
      output: encrypted.size,
      ms: Math.round(performance.now() - t1),
    });

    await renderSeeding(file, encrypted, hex);
  } catch (err) {
    console.error(err);
    logEvent('crypto', 'err', err instanceof Error ? err.message : String(err));
    renderSendError(err instanceof Error ? err.message : String(err));
  }
}

// ====================================================================
//  SEND MODE — ENCRYPTING
// ====================================================================

function renderEncrypting(file: File): void {
  clear(app);

  const sec = h(
    'section',
    {},
    sectionHeader('encrypting locally', 'aes-gcm-256'),
    fileMeta(file),
    h('div', { class: 'progress progress-indeterminate' }, h('div', { class: 'progress-fill' })),
    h(
      'div',
      { class: 'alert alert-info', style: 'margin-top:14px' },
      icon('lock', 'icon'),
      h(
        'p',
        {},
        h('strong', {}, 'encrypting · '),
        'Generating a fresh AES-GCM-256 key in your browser and encrypting the file. The key will only ever live in this tab and in the URL fragment.',
      ),
    ),
  );
  app.appendChild(sec);
}

// ====================================================================
//  SEND MODE — SEEDING
// ====================================================================

async function renderSeeding(originalFile: File, encryptedFile: File, keyHex: string): Promise<void> {
  clear(app);
  setStatus('warn', 'seeding');
  setStatusMode('seed');
  lockUnload('seeding active — closing the tab will tear down the swarm');

  // Live red warning at the top
  const liveAlert = h(
    'div',
    { class: 'live-alert', role: 'alert' },
    h('span', { class: 'pulse' }),
    h(
      'div',
      { class: 'body' },
      h('strong', {}, '⚠ keep this tab open'),
      h(
        'span',
        {},
        'your browser is the seed — closing this tab tears down the swarm and the link goes dark instantly.',
      ),
    ),
  );

  // Section: identity
  const idHead = sectionHeader('drop session', `key ${fingerprint(keyHex)}`);
  const idMeta = fileMeta(originalFile);

  // Section: share link
  const linkInput = h('input', {
    type: 'text',
    readonly: '',
    value: 'starting webtorrent swarm…',
    'aria-label': 'Share URL',
  }) as HTMLInputElement;
  const copyBtn = h('button', { class: 'primary', disabled: '' }, 'copy link');
  const shareBtn = h('button', { class: 'ghost', disabled: '' }, 'share');
  const newBtn = h('button', { class: 'ghost' }, 'drop another');

  const linkCard = h(
    'section',
    {},
    sectionHeader('share link', 'fragment never leaves the browser'),
    h('div', { class: 'share-url' }, linkInput, copyBtn),
    h('div', { class: 'btn-row', style: 'margin-top:10px' }, shareBtn, newBtn),
  );

  // Section: live network viz
  const viz = createNetworkViz();
  const netSection = h(
    'section',
    { style: 'margin-top:14px' },
    sectionHeader('live network topology', 'browser ↔ trackers ↔ peers'),
    viz.el,
  );

  // Section: stats
  const downStat = kvCell('down', '0 B/s');
  const upStat = kvCell('up', '0 B/s');
  const peerStat = kvCell('peers', '0');
  const ratioStat = kvCell('ratio', '0.00');
  const uploadedStat = kvCell('uploaded', '0 B');
  const elapsedStat = kvCell('elapsed', '0s');

  const statsGrid = h(
    'div',
    { class: 'kv-grid' },
    downStat,
    upStat,
    peerStat,
    ratioStat,
    uploadedStat,
    elapsedStat,
  );

  const statsSection = h(
    'section',
    { style: 'margin-top:14px' },
    sectionHeader('live transfer metrics', 'realtime'),
    statsGrid,
  );

  app.appendChild(liveAlert);
  app.appendChild(h('section', {}, idHead, idMeta));
  app.appendChild(linkCard);
  app.appendChild(netSection);
  app.appendChild(statsSection);

  const startedAt = Date.now();

  // Initial network viz state
  viz.update({
    mode: 'send',
    trackers: [],
    peers: [],
    downloadSpeed: 0,
    uploadSpeed: 0,
    fileSize: encryptedFile.size,
    fileName: originalFile.name,
  });

  logEvent('crypto', 'info', `encrypted payload ${encryptedFile.size.toLocaleString()} bytes`);
  logEvent('net', 'info', 'joining webtorrent swarm');

  let lastTrackers: TrackerInfo[] = [];
  let lastPeers: PeerInfo[] = [];

  const seenPeers = new Set<string>();

  const { magnetURI, infoHash } = await seedFile(client, encryptedFile, {
    onProgress: (info) => {
      downStat.querySelector('.value')!.textContent = formatSpeed(info.downloadSpeed);
      upStat.querySelector('.value')!.textContent = formatSpeed(info.uploadSpeed);
      peerStat.querySelector('.value')!.textContent = String(info.numPeers);
      ratioStat.querySelector('.value')!.textContent = info.ratio.toFixed(2);
      uploadedStat.querySelector('.value')!.textContent = formatBytes(info.uploaded);
      elapsedStat.querySelector('.value')!.textContent = formatSeconds(
        (Date.now() - startedAt) / 1000,
      );

      setStatusPeers(info.numPeers);
      setStatusThroughput(info.downloadSpeed, info.uploadSpeed);

      viz.update({
        mode: 'send',
        trackers: lastTrackers,
        peers: lastPeers,
        downloadSpeed: info.downloadSpeed,
        uploadSpeed: info.uploadSpeed,
        fileSize: encryptedFile.size,
        fileName: originalFile.name,
      });
    },
    onPeer: (peers) => {
      lastPeers = peers;
      for (const p of peers) {
        if (!seenPeers.has(p.id || p.addr)) {
          seenPeers.add(p.id || p.addr);
          logEvent('peer', 'ok', `peer connected · ${p.addr || p.type}`, {
            type: p.type,
            id: (p.id || '').slice(0, 12) || 'unknown',
          });
        }
      }
      viz.update({
        mode: 'send',
        trackers: lastTrackers,
        peers: lastPeers,
        downloadSpeed: 0,
        uploadSpeed: 0,
        fileSize: encryptedFile.size,
        fileName: originalFile.name,
      });
    },
    onTrackers: (trackers) => {
      lastTrackers = trackers;
      const connected = trackers.filter((t) => t.status === 'connected').length;
      setStatusTrackers(connected, trackers.length);
      viz.update({
        mode: 'send',
        trackers: lastTrackers,
        peers: lastPeers,
        downloadSpeed: 0,
        uploadSpeed: 0,
        fileSize: encryptedFile.size,
        fileName: originalFile.name,
      });
    },
    onLog: (msg, kind) => {
      // Categorize torrent-layer messages by keyword
      const m = msg.toLowerCase();
      if (m.includes('tracker')) logEvent('tracker', kind || 'info', msg);
      else if (m.includes('wire') || m.includes('handshake') || m.includes('first byte')) logEvent('wire', kind || 'info', msg);
      else if (m.includes('peer')) logEvent('peer', kind || 'info', msg);
      else logEvent('net', kind || 'info', msg);
    },
    onError: (err) => {
      logEvent('net', 'err', `error: ${err.message}`);
      setStatus('bad', 'error');
    },
  });

  const shareUrl = buildShareUrl(magnetURI, keyHex);
  linkInput.value = shareUrl;
  copyBtn.removeAttribute('disabled');

  logEvent('net', 'ok', 'magnet ready', { infohash: infoHash.slice(0, 16) + '…' });
  logEvent('ui', 'ok', 'share link generated · waiting for peers');

  setStatus('good', 'live · awaiting peers');

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast('link copied');
      logEvent('ui', 'ok', 'share link copied to clipboard');
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
        logEvent('ui', 'ok', 'share sheet invoked');
      } catch {
        /* user cancelled */
      }
    });
  }

  newBtn.addEventListener('click', () => {
    window.open(window.location.origin + window.location.pathname, '_blank');
    logEvent('ui', 'info', 'opening new tab for fresh drop');
  });
}

function renderSendError(msg: string): void {
  clear(app);
  unlockUnload();
  setStatus('bad', 'error');
  app.appendChild(
    h(
      'section',
      {},
      sectionHeader('error', 'send aborted'),
      h(
        'div',
        { class: 'alert alert-error' },
        icon('warn', 'icon'),
        h('p', {}, h('strong', {}, 'aborted · '), msg),
      ),
      h(
        'div',
        { class: 'btn-row', style: 'margin-top:14px' },
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
  setStatus('warn', 'receiving');
  setStatusMode('receive');
  lockUnload('receive in progress — closing tab abandons the transfer');

  logEvent('net', 'info', 'parsed share url', {
    infohash: (magnetURI.match(/btih:([a-f0-9]+)/i)?.[1] || '?').slice(0, 16) + '…',
  });
  logEvent('crypto', 'info', 'key fingerprint loaded', { fp: fingerprint(keyHex) });

  const idHead = sectionHeader('incoming drop', `key ${fingerprint(keyHex)}`);

  const progressBar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const progressSection = h(
    'section',
    {},
    idHead,
    h(
      'div',
      { class: 'alert alert-info', style: 'margin-bottom:14px' },
      icon('info', 'icon'),
      h(
        'p',
        {},
        h('strong', {}, 'connecting · '),
        'streaming ciphertext peer-to-peer over WebRTC. Decryption happens in this browser, never on a server.',
      ),
    ),
    progressBar,
  );

  const viz = createNetworkViz();
  const netSection = h(
    'section',
    { style: 'margin-top:14px' },
    sectionHeader('live network topology', 'browser ↔ trackers ↔ peers'),
    viz.el,
  );

  const pctStat = kvCell('progress', '0%');
  const downStat = kvCell('down', '0 B/s');
  const sizeStat = kvCell('downloaded', '0 B');
  const peerStat = kvCell('peers', '0');
  const etaStat = kvCell('eta', '—');
  const elapsedStat = kvCell('elapsed', '0s');
  const statsGrid = h(
    'div',
    { class: 'kv-grid' },
    pctStat,
    downStat,
    sizeStat,
    peerStat,
    etaStat,
    elapsedStat,
  );
  const statsSection = h(
    'section',
    { style: 'margin-top:14px' },
    sectionHeader('live transfer metrics', 'realtime'),
    statsGrid,
  );

  app.appendChild(progressSection);
  app.appendChild(netSection);
  app.appendChild(statsSection);

  viz.update({
    mode: 'receive',
    trackers: [],
    peers: [],
    downloadSpeed: 0,
    uploadSpeed: 0,
    fileSize: 0,
    fileName: '',
  });

  const startedAt = Date.now();
  let lastTrackers: TrackerInfo[] = [];
  let lastPeers: PeerInfo[] = [];
  const seenPeers = new Set<string>();
  let totalSize = 0;

  logEvent('net', 'info', 'joining swarm, waiting for peers');

  const key = await importKey(keyHex);

  const result = await downloadFile(client, magnetURI, {
    onProgress: (info) => {
      totalSize = info.total || totalSize;
      (progressBar.firstElementChild as HTMLElement).style.width = `${info.percent.toFixed(1)}%`;
      pctStat.querySelector('.value')!.textContent = `${info.percent.toFixed(0)}%`;
      downStat.querySelector('.value')!.textContent = formatSpeed(info.downloadSpeed);
      sizeStat.querySelector('.value')!.textContent = formatBytes(info.downloaded);
      peerStat.querySelector('.value')!.textContent = String(info.numPeers);
      etaStat.querySelector('.value')!.textContent = formatSeconds(info.timeRemaining / 1000);
      elapsedStat.querySelector('.value')!.textContent = formatSeconds(
        (Date.now() - startedAt) / 1000,
      );

      setStatusPeers(info.numPeers);
      setStatusThroughput(info.downloadSpeed, 0);

      viz.update({
        mode: 'receive',
        trackers: lastTrackers,
        peers: lastPeers,
        downloadSpeed: info.downloadSpeed,
        uploadSpeed: info.uploadSpeed,
        fileSize: totalSize,
        fileName: '',
      });
    },
    onPeer: (peers) => {
      lastPeers = peers;
      for (const p of peers) {
        if (!seenPeers.has(p.id || p.addr)) {
          seenPeers.add(p.id || p.addr);
          logEvent('peer', 'ok', `peer connected · ${p.addr || p.type}`, {
            type: p.type,
            id: (p.id || '').slice(0, 12) || 'unknown',
          });
        }
      }
      viz.update({
        mode: 'receive',
        trackers: lastTrackers,
        peers: lastPeers,
        downloadSpeed: 0,
        uploadSpeed: 0,
        fileSize: totalSize,
        fileName: '',
      });
    },
    onTrackers: (trackers) => {
      lastTrackers = trackers;
      const connected = trackers.filter((t) => t.status === 'connected').length;
      setStatusTrackers(connected, trackers.length);
      viz.update({
        mode: 'receive',
        trackers: lastTrackers,
        peers: lastPeers,
        downloadSpeed: 0,
        uploadSpeed: 0,
        fileSize: totalSize,
        fileName: '',
      });
    },
    onLog: (msg, kind) => {
      const m = msg.toLowerCase();
      if (m.includes('tracker')) logEvent('tracker', kind || 'info', msg);
      else if (m.includes('wire') || m.includes('handshake') || m.includes('first byte')) logEvent('wire', kind || 'info', msg);
      else if (m.includes('peer')) logEvent('peer', kind || 'info', msg);
      else logEvent('net', kind || 'info', msg);
    },
    onError: (err) => {
      logEvent('net', 'err', err.message);
      setStatus('bad', 'error');
    },
  });

  logEvent('net', 'ok', 'download complete', { bytes: totalSize });
  logEvent('crypto', 'info', 'decrypting payload in-browser');

  const buffer = await result.blob.arrayBuffer();
  const t0 = performance.now();
  const { name, blob } = await decryptBlob(buffer, key);
  logEvent('crypto', 'ok', `decryption complete · ${name}`, {
    size: blob.size,
    ms: Math.round(performance.now() - t0),
  });

  unlockUnload();
  renderReceiveComplete(name, blob);
}

function renderReceiveComplete(name: string, blob: Blob): void {
  clear(app);
  setStatus('good', 'complete');

  const url = URL.createObjectURL(blob);

  const dl = h(
    'a',
    { class: 'btn primary', href: url, download: name, role: 'button' },
    'save file',
  );
  dl.addEventListener('click', () => {
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  });

  const sec = h(
    'section',
    {},
    sectionHeader('decryption successful', 'integrity verified'),
    h(
      'div',
      { class: 'complete-hero' },
      icon('check', 'check'),
      h('h3', {}, name),
      h('p', {}, `${formatBytes(blob.size)} · decrypted locally`),
      dl,
    ),
    h(
      'div',
      { class: 'alert alert-info', style: 'margin-top:14px' },
      icon('info', 'icon'),
      h(
        'p',
        {},
        h('strong', {}, 'done · '),
        "the sender can close their tab once you've saved the file. ",
        h(
          'a',
          { href: window.location.origin + window.location.pathname },
          'drop your own file',
        ),
        '.',
      ),
    ),
  );
  app.appendChild(sec);
}

function renderReceiveError(msg: string): void {
  clear(app);
  unlockUnload();
  setStatus('bad', 'error');

  app.appendChild(
    h(
      'section',
      {},
      sectionHeader('receive failed', 'transfer aborted'),
      h(
        'div',
        { class: 'alert alert-error' },
        icon('warn', 'icon'),
        h('p', {}, h('strong', {}, 'aborted · '), msg),
      ),
      h(
        'p',
        { style: 'color: var(--fg-2); font-size: 11px; margin-top: 14px; text-transform:uppercase; letter-spacing:0.06em;' },
        '// common causes: sender closed tab · firewall blocking webrtc · link altered in transit',
      ),
      h(
        'div',
        { class: 'btn-row', style: 'margin-top:14px' },
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

function sectionHeader(title: string, meta = ''): HTMLElement {
  return h(
    'div',
    { class: 'sh' },
    h('h2', {}, title),
    h('span', { class: 'sh-meta' }, meta),
  );
}

function fileMeta(file: File): HTMLElement {
  return h(
    'div',
    { class: 'file-meta' },
    icon('file', 'file-icon'),
    h('div', { class: 'file-name' }, file.name),
    h('div', { class: 'file-size' }, formatBytes(file.size)),
  );
}

function kvCell(label: string, value: string): HTMLElement {
  return h(
    'div',
    { class: 'kv-cell' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
  );
}

function featurePill(iconName: 'lock' | 'info' | 'share', label: string): HTMLElement {
  return h('div', { class: 'feature-pill' }, icon(iconName), h('span', {}, label));
}

/** First and last 4 chars of the hex key — enough to compare visually. */
function fingerprint(hex: string): string {
  if (hex.length < 10) return hex;
  return `${hex.slice(0, 4)}…${hex.slice(-4)}`;
}
