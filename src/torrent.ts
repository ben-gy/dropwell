/**
 * WebTorrent wrapper for Dropwell.
 *
 * Wraps the WebTorrent client in a tiny Promise-based facade so that the UI
 * code doesn't have to know about event names or tracker URLs. Exposes
 * real-time handlers for peers, wires, pieces, trackers, and speeds.
 */

// WebTorrent's published types are loose; we work against a light interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebTorrentClient = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TorrentHandle = any;

// Use the browser bundle — webtorrent/dist/webtorrent.min.js — which is
// pre-built for browsers and avoids Node-only polyfills at build time.
// @ts-expect-error — no types for the dist path
import WebTorrent from 'webtorrent/dist/webtorrent.min.js';

export const TRACKERS: string[] = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.btorrent.xyz',
];

export interface PeerInfo {
  id: string; // peer-id string or fingerprint
  addr: string; // remote address (best-effort)
  type: string; // 'webrtc' | 'tcpOutgoing' | etc.
  uploaded: number;
  downloaded: number;
  connectedAt: number; // timestamp
}

export interface TrackerInfo {
  url: string;
  status: 'connecting' | 'connected' | 'error';
  peers?: number;
  error?: string;
}

export interface SeedResult {
  magnetURI: string;
  infoHash: string;
  torrent: TorrentHandle;
}

export interface DownloadResult {
  blob: Blob;
  torrent: TorrentHandle;
}

export interface ProgressHandlers {
  onProgress?: (info: {
    percent: number;
    downloadSpeed: number;
    uploadSpeed: number;
    downloaded: number;
    uploaded: number;
    total: number;
    timeRemaining: number;
    ratio: number;
    numPeers: number;
  }) => void;
  onPeer?: (peers: PeerInfo[]) => void;
  onTrackers?: (trackers: TrackerInfo[]) => void;
  onLog?: (msg: string, kind?: 'info' | 'ok' | 'err') => void;
  onError?: (err: Error) => void;
  onDone?: () => void;
}

/** Create a fresh WebTorrent client. Caller is responsible for destroying it. */
export function createClient(): WebTorrentClient {
  return new WebTorrent();
}

// ---------- shared helpers ----------

function wirePeers(torrent: TorrentHandle): PeerInfo[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (torrent.wires || []).map((w: any) => ({
    id: w.peerId || '',
    addr: w.remoteAddress ? `${w.remoteAddress}:${w.remotePort ?? '?'}` : (w.type ?? 'webrtc'),
    type: w.type ?? 'webrtc',
    uploaded: w.uploaded ?? 0,
    downloaded: w.downloaded ?? 0,
    connectedAt: Date.now(),
  }));
}

function initialTrackers(): TrackerInfo[] {
  return TRACKERS.map((url) => ({ url, status: 'connecting' }));
}

/** Hook into torrent events to emit real-time data to the UI. */
function attachHandlers(torrent: TorrentHandle, h: ProgressHandlers): void {
  const trackers: TrackerInfo[] = initialTrackers();

  const updateTrackers = () => h.onTrackers?.(trackers.slice());
  const emitPeers = () => h.onPeer?.(wirePeers(torrent));
  const emitProgress = () => {
    h.onProgress?.({
      percent: (torrent.progress || 0) * 100,
      downloadSpeed: torrent.downloadSpeed || 0,
      uploadSpeed: torrent.uploadSpeed || 0,
      downloaded: torrent.downloaded || 0,
      uploaded: torrent.uploaded || 0,
      total: torrent.length || 0,
      timeRemaining: torrent.timeRemaining || 0,
      ratio: torrent.ratio || 0,
      numPeers: torrent.numPeers || 0,
    });
  };

  torrent.on('wire', (wire: unknown) => {
    h.onLog?.('wire connected — peer handshake complete', 'ok');
    void wire;
    emitPeers();
    emitProgress();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  torrent.on('noPeers', (announceType: any) => {
    h.onLog?.(`no peers yet (${announceType})`, 'info');
  });

  // tracker events are on torrent.discovery.tracker
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const disc: any = torrent.discovery;
    if (disc?.tracker) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      disc.tracker.on('update', (data: any) => {
        const t = trackers.find((x) => x.url === data?.announce);
        if (t) {
          t.status = 'connected';
          t.peers = data?.complete ?? data?.incomplete ?? t.peers;
          updateTrackers();
          h.onLog?.(`tracker ${short(t.url)} → connected`, 'ok');
        }
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      disc.tracker.on('warning', (err: any) => {
        h.onLog?.(`tracker warning: ${err?.message ?? err}`, 'info');
      });
    }
  } catch {
    /* ignore — structure may vary */
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  torrent.on('trackerAnnounce', () => {
    h.onLog?.('announced to trackers', 'info');
  });

  torrent.on('download', () => emitProgress());
  torrent.on('upload', () => emitProgress());

  torrent.on('done', () => {
    emitProgress();
    h.onDone?.();
  });

  torrent.on('error', (err: Error) => h.onError?.(err));

  // Kick off with an initial state emission so UI is populated immediately.
  updateTrackers();
  emitPeers();
  emitProgress();
}

function short(url: string): string {
  return url.replace(/^wss?:\/\//, '').replace(/\/.*/, '');
}

/** Seed an encrypted File on the torrent network. */
export function seedFile(
  client: WebTorrentClient,
  file: File,
  handlers: ProgressHandlers = {},
): Promise<SeedResult> {
  return new Promise((resolve, reject) => {
    try {
      client.seed(file, { announce: TRACKERS }, (torrent: TorrentHandle) => {
        attachHandlers(torrent, handlers);
        resolve({ magnetURI: torrent.magnetURI, infoHash: torrent.infoHash, torrent });
      });
      client.on('error', (err: Error) => {
        handlers.onError?.(err);
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Download a torrent from a magnet URI and collect every piece into a Blob.
 * Resolves when the full payload is in memory.
 */
export function downloadFile(
  client: WebTorrentClient,
  magnetURI: string,
  handlers: ProgressHandlers = {},
  timeoutMs = 60_000,
): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let gotFirstPiece = false;

    const noPeerTimer = setTimeout(() => {
      if (!gotFirstPiece && !resolved) {
        resolved = true;
        try {
          client.remove(magnetURI);
        } catch {
          /* ignore */
        }
        reject(
          new Error(
            "No peers found. The sender's tab may be closed, or your network is blocking P2P.",
          ),
        );
      }
    }, timeoutMs);

    try {
      client.add(magnetURI, { announce: TRACKERS }, (torrent: TorrentHandle) => {
        attachHandlers(torrent, handlers);

        torrent.on('download', () => {
          if (!gotFirstPiece) {
            gotFirstPiece = true;
            clearTimeout(noPeerTimer);
            handlers.onLog?.('first bytes received', 'ok');
          }
        });

        torrent.on('error', (err: Error) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(noPeerTimer);
            reject(err);
          }
        });

        torrent.on('done', async () => {
          try {
            const f = torrent.files[0];
            const blob: Blob = await f.blob();
            if (resolved) return;
            resolved = true;
            clearTimeout(noPeerTimer);
            resolve({ blob, torrent });
          } catch (err) {
            if (resolved) return;
            resolved = true;
            clearTimeout(noPeerTimer);
            reject(err);
          }
        });
      });

      client.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(noPeerTimer);
          handlers.onError?.(err);
          reject(err);
        }
      });
    } catch (err) {
      clearTimeout(noPeerTimer);
      reject(err);
    }
  });
}

/** Destroy a client cleanly — call on page unload. */
export function destroyClient(client: WebTorrentClient): void {
  try {
    client.destroy();
  } catch {
    /* ignore */
  }
}
