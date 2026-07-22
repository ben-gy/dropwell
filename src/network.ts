// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * Network visualization.
 *
 * SVG diagram showing the relationship between THIS browser, the
 * trackers it's announcing to, and any peers currently connected. Updates
 * incrementally as the torrent layer reports new state.
 *
 *   [tracker]    [tracker]    [tracker]
 *        \           |           /
 *         \          |          /
 *          \         |         /
 *           \        |        /
 *            +---  SELF  ---+
 *           /        |        \
 *          /         |         \
 *      [peer]     [peer]     [peer] ...
 *
 * Tracker links are dashed (signaling). Peer links are solid (data) and
 * pulse when bytes are flowing in either direction.
 */
import type { PeerInfo, TrackerInfo } from './torrent';

export interface NetworkState {
  mode: 'send' | 'receive';
  trackers: TrackerInfo[];
  peers: PeerInfo[];
  downloadSpeed: number;
  uploadSpeed: number;
  fileSize: number;
  fileName: string;
}

export interface NetworkViz {
  el: HTMLElement;
  update: (state: NetworkState) => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_W = 440;
const VIEW_H = 560;
const CENTER_X = VIEW_W / 2;
const CENTER_Y = VIEW_H / 2;
const TRACKER_ROW_Y = 48;
const PEER_ROW_Y = VIEW_H - 48;

function svg<T extends SVGElement>(tag: string, attrs: Record<string, string | number> = {}): T {
  const el = document.createElementNS(SVG_NS, tag) as T;
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

function shortTracker(url: string): string {
  let host = url.replace(/^wss?:\/\//, '').replace(/\/.*/, '');
  // strip a leading "tracker." prefix — common across the public webrtc trackers
  host = host.replace(/^tracker\./, '');
  // if still long, drop the leading subdomain (e.g. "openwebtorrent.com")
  if (host.length > 18) {
    const parts = host.split('.');
    if (parts.length > 2) host = parts.slice(-2).join('.');
  }
  // last-resort truncate
  if (host.length > 20) host = host.slice(0, 19) + '…';
  return host;
}

function shortPeer(p: PeerInfo): string {
  if (p.addr && p.addr.length < 18) return p.addr;
  if (p.id) return p.id.slice(0, 8);
  return p.type || 'peer';
}

/** Compute the bounding box of a node centered at (cx, cy) with given dimensions. */
function nodeBox(cx: number, cy: number, w: number, h: number) {
  return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy };
}

/** Linearly distribute N items across [x0, x1] at y. Single item centers. */
function distribute(n: number, x0: number, x1: number, y: number): { x: number; y: number }[] {
  if (n === 0) return [];
  if (n === 1) return [{ x: (x0 + x1) / 2, y }];
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push({ x: x0 + (x1 - x0) * t, y });
  }
  return out;
}

export function createNetworkViz(): NetworkViz {
  const wrap = document.createElement('div');
  wrap.className = 'netviz-wrap';

  const root = svg<SVGSVGElement>('svg', {
    class: 'netviz',
    viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
    preserveAspectRatio: 'xMidYMid meet',
    'aria-label': 'Live network topology',
  });
  wrap.appendChild(root);

  // Layers (order: links → nodes → pulses)
  const linkLayer = svg<SVGGElement>('g', { class: 'link-layer' });
  const nodeLayer = svg<SVGGElement>('g', { class: 'node-layer' });
  const pulseLayer = svg<SVGGElement>('g', { class: 'pulse-layer' });
  root.appendChild(linkLayer);
  root.appendChild(nodeLayer);
  root.appendChild(pulseLayer);

  // Static SELF node — recreated only when name/size changes
  let lastSelfLabel = '';

  function renderSelf(state: NetworkState): {
    x: number;
    y: number;
    w: number;
    h: number;
    cx: number;
    cy: number;
  } {
    const w = 152;
    const h = 48;
    const box = nodeBox(CENTER_X, CENTER_Y, w, h);

    const label = `${state.mode === 'send' ? 'seeding' : 'receiving'} · ${formatBytes(state.fileSize)}`;
    if (label === lastSelfLabel) {
      const existing = nodeLayer.querySelector('.node-self');
      if (existing) return box;
    }
    lastSelfLabel = label;

    // Remove old self
    nodeLayer.querySelector('.node-self')?.remove();

    const g = svg<SVGGElement>('g', { class: 'node-self' });
    const rect = svg<SVGRectElement>('rect', {
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      rx: 3,
    });
    const labelText = svg<SVGTextElement>('text', {
      class: 'label',
      x: CENTER_X,
      y: CENTER_Y - 3,
      'text-anchor': 'middle',
    });
    labelText.textContent = 'this browser';
    const subText = svg<SVGTextElement>('text', {
      class: 'sub',
      x: CENTER_X,
      y: CENTER_Y + 10,
      'text-anchor': 'middle',
    });
    subText.textContent = label;
    g.appendChild(rect);
    g.appendChild(labelText);
    g.appendChild(subText);
    nodeLayer.appendChild(g);
    return box;
  }

  function renderTrackers(
    state: NetworkState,
    selfBox: { x: number; y: number; w: number; h: number; cx: number; cy: number },
  ) {
    // Wipe + redraw — small N so this is cheap.
    nodeLayer.querySelectorAll('.node-tracker').forEach((n) => n.remove());
    linkLayer.querySelectorAll('.link-tracker').forEach((n) => n.remove());

    const nodeW = 116;
    const nodeH = 22;
    const rowY = TRACKER_ROW_Y;
    const margin = nodeW / 2 + 8;
    const positions = distribute(state.trackers.length, margin, VIEW_W - margin, rowY);

    state.trackers.forEach((t, i) => {
      const pos = positions[i];
      // Link
      const link = svg<SVGPathElement>('path', {
        class: `link link-tracker ${t.status}`,
        d: pathFromTo(pos.x, pos.y + nodeH / 2, selfBox.cx, selfBox.y),
      });
      linkLayer.appendChild(link);

      // Node
      const g = svg<SVGGElement>('g', { class: `node node-tracker ${t.status}` });
      const rect = svg<SVGRectElement>('rect', {
        x: pos.x - nodeW / 2,
        y: pos.y - nodeH / 2,
        width: nodeW,
        height: nodeH,
        rx: 2,
      });
      const labelText = svg<SVGTextElement>('text', {
        class: 'label',
        x: pos.x,
        y: pos.y - 1,
        'text-anchor': 'middle',
      });
      labelText.textContent = shortTracker(t.url);
      const subText = svg<SVGTextElement>('text', {
        class: 'sub',
        x: pos.x,
        y: pos.y + 8,
        'text-anchor': 'middle',
      });
      subText.textContent = t.status === 'connected' && t.peers != null ? `${t.peers} peers` : t.status;
      g.appendChild(rect);
      g.appendChild(labelText);
      g.appendChild(subText);
      nodeLayer.appendChild(g);
    });

    if (state.trackers.length === 0) {
      const t = svg<SVGTextElement>('text', { class: 'empty-label node-tracker', x: CENTER_X, y: TRACKER_ROW_Y });
      t.textContent = 'no trackers';
      nodeLayer.appendChild(t);
    }
  }

  function renderPeers(
    state: NetworkState,
    selfBox: { x: number; y: number; w: number; h: number; cx: number; cy: number },
  ) {
    nodeLayer.querySelectorAll('.node-peer').forEach((n) => n.remove());
    linkLayer.querySelectorAll('.link-peer').forEach((n) => n.remove());

    const nodeW = 100;
    const nodeH = 24;
    const rowY = PEER_ROW_Y;
    const margin = nodeW / 2 + 8;
    const positions = distribute(state.peers.length, margin, VIEW_W - margin, rowY);
    const active = state.downloadSpeed > 0 || state.uploadSpeed > 0;

    state.peers.forEach((p, i) => {
      const pos = positions[i];
      const link = svg<SVGPathElement>('path', {
        class: `link link-peer connected${active ? ' active' : ''}`,
        d: pathFromTo(pos.x, pos.y - nodeH / 2, selfBox.cx, selfBox.y + selfBox.h),
      });
      linkLayer.appendChild(link);

      const g = svg<SVGGElement>('g', { class: 'node node-peer connected' });
      const rect = svg<SVGRectElement>('rect', {
        x: pos.x - nodeW / 2,
        y: pos.y - nodeH / 2,
        width: nodeW,
        height: nodeH,
        rx: 2,
      });
      const labelText = svg<SVGTextElement>('text', {
        class: 'label',
        x: pos.x,
        y: pos.y - 1,
        'text-anchor': 'middle',
      });
      labelText.textContent = shortPeer(p);
      const subText = svg<SVGTextElement>('text', {
        class: 'sub',
        x: pos.x,
        y: pos.y + 8,
        'text-anchor': 'middle',
      });
      subText.textContent = `↑${formatBytes(p.uploaded)} ↓${formatBytes(p.downloaded)}`;
      g.appendChild(rect);
      g.appendChild(labelText);
      g.appendChild(subText);
      nodeLayer.appendChild(g);
    });

    if (state.peers.length === 0) {
      const t = svg<SVGTextElement>('text', {
        class: 'empty-label node-peer',
        x: CENTER_X,
        y: PEER_ROW_Y + 6,
      });
      t.textContent = state.mode === 'send' ? 'waiting for peers…' : 'searching for peers…';
      nodeLayer.appendChild(t);
    }
  }

  function pathFromTo(x1: number, y1: number, x2: number, y2: number): string {
    // Slight curve through midpoint for visual interest
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2 + (y2 > y1 ? -8 : 8);
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }

  function update(state: NetworkState) {
    const selfBox = renderSelf(state);
    renderTrackers(state, selfBox);
    renderPeers(state, selfBox);
  }

  return { el: wrap, update };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
