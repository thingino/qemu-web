// Boot stage from console text; stages only move forward until reset().
export const STAGES = ['Off', 'U-Boot', 'Kernel', 'Init', 'Shell'];
const RULES = [
  [1, /U-Boot|\bSPL\b/],
  [2, /Starting kernel|Linux version \d/],
  [3, /Freeing unused kernel memory/],
  [4, /login: ?$|\w+@[\w.\-]+ [^\n]*?[#$] /],
];
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g;

export const stripAnsi = (s) => s.replace(ANSI, '').replace(/\r(?!\n)/g, '');

export class StageDetector {
  constructor() { this.reset(); }
  reset() { this.stage = 0; this.raw = ''; this.dec = new TextDecoder('latin1'); }
  feed(bytes) {
    // strip escapes from the whole tail: a chunk can end inside one
    this.raw = (this.raw + this.dec.decode(bytes, { stream: true })).slice(-8192);
    const text = stripAnsi(this.raw);
    for (const [stage, re] of RULES) {
      if (stage > this.stage && re.test(text)) this.stage = stage;
    }
    return this.stage;
  }
}
