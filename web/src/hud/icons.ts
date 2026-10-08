// Small inline SVG icons for the ability and weapon slots, by name keyword.
const S = (body: string, col: string) =>
  `<svg viewBox="0 0 32 32" width="34" height="34" fill="none" stroke="${col}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS: [RegExp, string][] = [
  [/grenade|frag/i, S('<circle cx="15" cy="19" r="8" fill="#3d4a2c"/><path d="M13 11h5v-3h-5zM18 9l6-3"/><path d="M11 18h8M15 14v10" stroke-width="1.2"/>', '#b8d080')],
  [/napalm|fire|flame/i, S('<path d="M16 4c2 6 8 8 8 15a8 8 0 0 1-16 0c0-4 2-6 4-8 0 3 1 5 3 5-1-5 0-9 1-12z" fill="#7a2a08"/><path d="M16 27a4 4 0 0 1-4-4c0-2 2-4 4-6 2 2 4 4 4 6a4 4 0 0 1-4 4z" fill="#ffb030" stroke="none"/>', '#ff7a20')],
  [/air|strike|barrage/i, S('<path d="M16 3v12M10 9l6 6 6-6"/><circle cx="16" cy="23" r="6" fill="#5a1a10"/><path d="M8 23h-4M28 23h-4M16 31v-2"/>', '#ff5a40')],
  [/concuss|blast/i, S('<path d="M6 16h4M22 16h4M16 6v4M16 22v4M9 9l3 3M23 23l-3-3M23 9l-3 3M9 23l3-3"/><circle cx="16" cy="16" r="3" fill="#ffe0a0"/>', '#ffe0a0')],
  [/overdrive|spin|rate|hose/i, S('<path d="M8 22a10 10 0 1 1 16 0"/><path d="M16 16l6-6"/><circle cx="16" cy="16" r="2" fill="#80d0ff"/>', '#80d0ff')],
  [/rail|pierc/i, S('<path d="M3 16h26M22 10l7 6-7 6"/><path d="M8 12v8M13 12v8" stroke-width="1.4"/>', '#a0f0ff')],
  [/dash|sprint|blink/i, S('<path d="M4 12h9M2 17h11M5 22h8"/><path d="M15 9l9 7-9 7z" fill="#2a5a7a"/>', '#80d8ff')],
  [/fan|hammer/i, S('<path d="M6 24l10-16 10 16"/><path d="M16 8v18M11 16l-5 8M21 16l5 8" stroke-width="1.4"/>', '#ffe9a0')],
];

export function iconFor(name: string): string {
  for (const [re, svg] of ICONS) if (re.test(name)) return svg;
  return S('<circle cx="16" cy="16" r="10"/><path d="M16 2v8M16 22v8M2 16h8M22 16h8"/>', '#ffe9a0');
}
