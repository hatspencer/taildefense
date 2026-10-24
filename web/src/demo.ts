// The demo and the lab, bundled apart as demo.js: main.ts loads it only for #demo and #lab, so
// a real game never downloads it.
import { DemoHost } from './demo/host';
import { Lab } from './lab';
import { SoundLab } from './soundlab';

const tdDemo = { DemoHost, Lab, SoundLab };
export type TdDemo = typeof tdDemo;
(window as unknown as { tdDemo: TdDemo }).tdDemo = tdDemo;
