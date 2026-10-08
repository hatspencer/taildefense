// Small inline SVG icons for the ability and weapon slots, by name keyword. Drawn with square
// caps and crisp edges in the HUD's muted palette, so they read as pixel art at slot size.
const S = (body: string, col: string) =>
  `<svg viewBox="0 0 32 32" width="34" height="34" fill="none" stroke="${col}" stroke-width="2.5" stroke-linecap="square" stroke-linejoin="miter" shape-rendering="crispEdges">${body}</svg>`;

const ICONS: [RegExp, string][] = [
  [/grenade|frag/i, S('<circle cx="15" cy="19" r="8" fill="#3b4428"/><path d="M13 11h5v-3h-5zM18 9l6-3"/><path d="M11 18h8M15 14v10" stroke-width="1.5"/>', '#a8b874')],
  [/napalm|fire|flame/i, S('<path d="M16 4c2 6 8 8 8 15a8 8 0 0 1-16 0c0-4 2-6 4-8 0 3 1 5 3 5-1-5 0-9 1-12z" fill="#5a2410"/><path d="M16 27a4 4 0 0 1-4-4c0-2 2-4 4-6 2 2 4 4 4 6a4 4 0 0 1-4 4z" fill="#e0a63a" stroke="none"/>', '#cf6a2c')],
  [/air|strike|barrage/i, S('<path d="M16 3v12M10 9l6 6 6-6"/><circle cx="16" cy="23" r="6" fill="#4a1c12"/><path d="M8 23h-4M28 23h-4M16 31v-2"/>', '#c85a3c')],
  [/concuss|blast/i, S('<path d="M6 16h4M22 16h4M16 6v4M16 22v4M9 9l3 3M23 23l-3-3M23 9l-3 3M9 23l3-3"/><rect x="13" y="13" width="6" height="6" fill="#e6d29a" stroke="none"/>', '#e6d29a')],
  [/overdrive|spin|rate|hose/i, S('<path d="M8 22a10 10 0 1 1 16 0"/><path d="M16 16l6-6"/><rect x="14" y="14" width="4" height="4" fill="#86a2a6" stroke="none"/>', '#86a2a6')],
  [/rail|pierc/i, S('<path d="M3 16h26M22 10l7 6-7 6"/><path d="M8 12v8M13 12v8" stroke-width="1.5"/>', '#9ec0bc')],
  [/dash|sprint|blink/i, S('<path d="M4 12h9M2 17h11M5 22h8"/><path d="M15 9l9 7-9 7z" fill="#2f4a4c"/>', '#86a2a6')],
  [/fan|hammer/i, S('<path d="M6 24l10-16 10 16"/><path d="M16 8v18M11 16l-5 8M21 16l5 8" stroke-width="1.5"/>', '#e6d29a')],
  [/taunt|shout/i, S('<path d="M5 13h5l11-6v18l-11-6h-5z" fill="#4a2a1c"/><path d="M10 19l2 7h3l-1-7"/><path d="M25 11l3-2M26 16h4M25 21l3 2" stroke-width="2"/>', '#d98a62')],
];

export function iconFor(name: string): string {
  for (const [re, svg] of ICONS) if (re.test(name)) return svg;
  return S('<circle cx="16" cy="16" r="10"/><path d="M16 2v8M16 22v8M2 16h8M22 16h8"/>', '#e6d29a');
}

// Weather glyphs for the top bar, 16px, by weather kind (0 clear .. 4 snow, 5 drizzle, 6 thunder shower).
const W = (body: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" shape-rendering="crispEdges">${body}</svg>`;
const WEATHER = [
  W('<rect x="5" y="5" width="6" height="6" fill="#e0a63a"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3h1v1H3zM12 3h1v1h-1zM3 12h1v1H3zM12 12h1v1h-1z" stroke="#e0a63a" fill="#e0a63a"/>'),
  W('<path d="M2 4h10M4 7h11M1 10h9M5 13h9" stroke="#a8a690" stroke-width="2"/>'),
  W('<path d="M3 3h9v2h2v3H2V5h1z" fill="#8a9298"/><path d="M4 10v2M8 11v2M12 10v2M6 13v2M10 14v1" stroke="#86a2a6" stroke-width="1.5"/>'),
  W('<path d="M3 2h9v2h2v3H2V4h1z" fill="#6a6f74"/><path d="M8 7l-3 4h3l-2 4 5-6H8l2-2z" fill="#f4c25c"/>'),
  W('<path d="M8 1v14M1 8h14M3 3l10 10M13 3L3 13" stroke="#d9d1b3" stroke-width="1.5"/><rect x="6" y="6" width="4" height="4" fill="#2d3123"/>'),
  W('<path d="M3 4h9v2h2v3H2V6h1z" fill="#9aa2a6"/><path d="M5 11v1M10 12v1M7 14v1" stroke="#86a2a6" stroke-width="1.5"/>'),
  W('<path d="M3 3h9v2h2v3H2V5h1z" fill="#8a9298"/><path d="M9 8l-2 3h2l-1 3 3-4H9l1-2z" fill="#f4c25c"/><path d="M4 10v2M12 10v2" stroke="#86a2a6" stroke-width="1.5"/>'),
];

export function weatherIcon(kind: number): string {
  return WEATHER[kind] ?? WEATHER[0];
}
