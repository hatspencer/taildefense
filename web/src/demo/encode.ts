// A little-endian byte writer, used by the demo host to produce real protocol frames.
export class Writer {
  private buf = new ArrayBuffer(1 << 16);
  private d = new DataView(this.buf);
  private u8a = new Uint8Array(this.buf);
  o = 0;
  private static enc = new TextEncoder();

  reset(): void { this.o = 0; }

  private need(n: number): void {
    if (this.o + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.o + n) size *= 2;
    const nb = new ArrayBuffer(size);
    new Uint8Array(nb).set(this.u8a.subarray(0, this.o));
    this.buf = nb; this.d = new DataView(nb); this.u8a = new Uint8Array(nb);
  }

  u8(v: number): void { this.need(1); this.d.setUint8(this.o, v); this.o += 1; }
  i8(v: number): void { this.need(1); this.d.setInt8(this.o, v); this.o += 1; }
  u16(v: number): void { this.need(2); this.d.setUint16(this.o, Math.max(0, Math.min(65535, Math.round(v))), true); this.o += 2; }
  u32(v: number): void { this.need(4); this.d.setUint32(this.o, Math.max(0, Math.round(v)) >>> 0, true); this.o += 4; }
  q8(v: number): void { this.u16(v * 8); }
  bytes(b: Uint8Array): void { this.need(b.length); this.u8a.set(b, this.o); this.o += b.length; }
  str8(s: string): void { const b = Writer.enc.encode(s).subarray(0, 255); this.u8(b.length); this.bytes(b); }
  str16(s: string): void { const b = Writer.enc.encode(s); this.u16(b.length); this.bytes(b); }

  // A copy of what was written, as its own buffer (the receiver may keep it).
  take(): ArrayBuffer { return this.buf.slice(0, this.o); }
}
