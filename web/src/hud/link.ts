import type { PathMsg } from '../protocol';

// Over this average round trip the game feels late whatever the path, so the badge says so.
export const LAG_MS = 120;

// A path as F3 shows it: the words of tailnet.PathLabel, "unknown" while tailscale has chosen none.
export function pathLabel(p: PathMsg): string {
  switch (p.path) {
    case 'direct': case 'local': return p.path;
    case 'derp': return `DERP ${p.via ?? ''}`.trim();
    case 'peer-relay': return 'relay';
  }
  return 'unknown';
}

const FIX = 'Run td doctor to see why; UPnP or NAT-PMP on the router, or forwarding UDP 41641 to this machine, usually gives a direct path.';

// The link badge: text and its explanation, or null to hide it. It shows only when something
// can be done about it, a DERP relay or a slow round trip; a direct or local link with an ok
// ping is not worth the space.
export function linkBadge(p: PathMsg | null, rttAvg: number): { text: string; tip: string } | null {
  const ms = Number.isNaN(rttAvg) ? '' : ` · ${rttAvg.toFixed(0)} ms`;
  if (p?.path === 'derp') {
    const where = p.via ? ` in ${p.via}` : '';
    return { text: `${pathLabel(p)}${ms}`, tip: `Packets to the host are relayed through Tailscale's DERP server${where}, which adds latency. ${FIX}` };
  }
  if (rttAvg > LAG_MS) {
    const how = p && p.path !== 'idle' ? ` over a ${pathLabel(p)} path` : '';
    return { text: `lag ${rttAvg.toFixed(0)} ms`, tip: `The round trip to the host averages ${rttAvg.toFixed(0)} ms${how}. ${FIX}` };
  }
  return null;
}
