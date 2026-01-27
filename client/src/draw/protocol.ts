// Draw protocol message encoding
// Builds binary commands for /dev/draw/n/data writes

import { DrawCmd, DrawOp, Point, Rectangle } from './types.js';

// Binary write helpers (little-endian)
export class DrawBuffer {
  private data: number[] = [];

  writeByte(v: number): void {
    this.data.push(v & 0xFF);
  }

  writeShort(v: number): void {
    this.data.push(v & 0xFF);
    this.data.push((v >> 8) & 0xFF);
  }

  writeLong(v: number): void {
    this.data.push(v & 0xFF);
    this.data.push((v >> 8) & 0xFF);
    this.data.push((v >> 16) & 0xFF);
    this.data.push((v >> 24) & 0xFF);
  }

  writePoint(p: Point): void {
    this.writeLong(p.x);
    this.writeLong(p.y);
  }

  writeRect(r: Rectangle): void {
    this.writeLong(r.minX);
    this.writeLong(r.minY);
    this.writeLong(r.maxX);
    this.writeLong(r.maxY);
  }

  writeString(s: string): void {
    const bytes = new TextEncoder().encode(s);
    this.writeByte(bytes.length);
    for (const b of bytes) {
      this.writeByte(b);
    }
  }

  writeBytes(bytes: Uint8Array): void {
    for (const b of bytes) {
      this.data.push(b);
    }
  }

  // Variable-length coordinate encoding (Plan 9 drawcoord format)
  writeCoord(v: number, old: number): void {
    const delta = v - old;
    // If delta fits in 7 bits (-64 to 63), use 1 byte
    if (delta >= -64 && delta < 64) {
      // 1-byte delta: bit 7 = 0, bits 0-6 = delta
      this.writeByte(delta & 0x7F);
    } else {
      // 3-byte absolute: bit 7 = 1
      this.writeByte(0x80 | (v & 0x7F));
      this.writeByte((v >> 7) & 0xFF);
      this.writeByte((v >> 15) & 0xFF);
    }
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.data);
  }

  get length(): number {
    return this.data.length;
  }

  clear(): void {
    this.data = [];
  }
}

// Binary read helpers (little-endian)
export class DrawReader {
  private view: DataView;
  private offset = 0;

  constructor(data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  get position(): number {
    return this.offset;
  }

  readByte(): number {
    return this.view.getUint8(this.offset++);
  }

  readShort(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  readLong(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readULong(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readPoint(): Point {
    return {
      x: this.readLong(),
      y: this.readLong(),
    };
  }

  readRect(): Rectangle {
    return {
      minX: this.readLong(),
      minY: this.readLong(),
      maxX: this.readLong(),
      maxY: this.readLong(),
    };
  }

  readString(): string {
    const len = this.readByte();
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len);
    this.offset += len;
    return new TextDecoder().decode(bytes);
  }

  readBytes(n: number): Uint8Array {
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, n);
    this.offset += n;
    return bytes;
  }

  readCoord(old: number): number {
    const b = this.readByte();
    let x = b & 0x7F;

    if ((b & 0x80) !== 0) {
      // 3-byte absolute coordinate
      x |= this.readByte() << 7;
      x |= this.readByte() << 15;
      // Sign extend
      if ((x & (1 << 22)) !== 0) {
        x |= ~0 << 23;
      }
    } else {
      // 1-byte delta from old
      if ((b & 0x40) !== 0) {
        x |= ~0 << 7; // Sign extend negative delta
      }
      x += old;
    }

    return x;
  }
}

// Command builders
export const DrawProtocol = {
  // 'b' - Allocate image
  // b id[4] screenid[4] refresh[1] chan[4] repl[1] r[4*4] clipr[4*4] color[4]
  alloc(id: number, screenId: number, refresh: number, chan: number, repl: boolean,
        r: Rectangle, clipr: Rectangle, color: number): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.Alloc);
    buf.writeLong(id);
    buf.writeLong(screenId);
    buf.writeByte(refresh);
    buf.writeLong(chan);
    buf.writeByte(repl ? 1 : 0);
    buf.writeRect(r);
    buf.writeRect(clipr);
    buf.writeLong(color);
    return buf.toUint8Array();
  },

  // 'f' - Free image
  free(id: number): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.Free);
    buf.writeLong(id);
    return buf.toUint8Array();
  },

  // 'd' - Draw (blit)
  // d dstid[4] srcid[4] maskid[4] r[4*4] sp[2*4] mp[2*4]
  draw(dstId: number, srcId: number, maskId: number, r: Rectangle, sp: Point, mp: Point): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.Draw);
    buf.writeLong(dstId);
    buf.writeLong(srcId);
    buf.writeLong(maskId);
    buf.writeRect(r);
    buf.writePoint(sp);
    buf.writePoint(mp);
    return buf.toUint8Array();
  },

  // 'L' - Line
  // L dstid[4] p0[2*4] p1[2*4] end0[4] end1[4] radius[4] srcid[4] sp[2*4]
  line(dstId: number, p0: Point, p1: Point, end0: number, end1: number,
       radius: number, srcId: number, sp: Point): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.Line);
    buf.writeLong(dstId);
    buf.writePoint(p0);
    buf.writePoint(p1);
    buf.writeLong(end0);
    buf.writeLong(end1);
    buf.writeLong(radius);
    buf.writeLong(srcId);
    buf.writePoint(sp);
    return buf.toUint8Array();
  },

  // 'e' - Ellipse
  // e dstid[4] srcid[4] center[2*4] a[4] b[4] thick[4] sp[2*4] alpha[4] phi[4]
  ellipse(dstId: number, srcId: number, center: Point, a: number, b: number,
          thick: number, sp: Point, alpha: number = 0, phi: number = 0): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.Ellipse);
    buf.writeLong(dstId);
    buf.writeLong(srcId);
    buf.writePoint(center);
    buf.writeLong(a);
    buf.writeLong(b);
    buf.writeLong(thick);
    buf.writePoint(sp);
    buf.writeLong(alpha);
    buf.writeLong(phi);
    return buf.toUint8Array();
  },

  // 'E' - Filled Ellipse
  ellipseFill(dstId: number, srcId: number, center: Point, a: number, b: number,
              sp: Point, alpha: number = 0, phi: number = 0): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.EllipseFill);
    buf.writeLong(dstId);
    buf.writeLong(srcId);
    buf.writePoint(center);
    buf.writeLong(a);
    buf.writeLong(b);
    buf.writeLong(0); // thick (ignored for filled)
    buf.writePoint(sp);
    buf.writeLong(alpha);
    buf.writeLong(phi);
    return buf.toUint8Array();
  },

  // 'a' - Arc
  arc(dstId: number, srcId: number, center: Point, a: number, b: number,
      thick: number, sp: Point, alpha: number, phi: number): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.Arc);
    buf.writeLong(dstId);
    buf.writeLong(srcId);
    buf.writePoint(center);
    buf.writeLong(a);
    buf.writeLong(b);
    buf.writeLong(thick);
    buf.writePoint(sp);
    buf.writeLong(alpha);
    buf.writeLong(phi);
    return buf.toUint8Array();
  },

  // 'p' - Poly (outline)
  // p dstid[4] n[2] end0[4] end1[4] radius[4] srcid[4] sp[2*4] dp[variable]
  poly(dstId: number, pts: Point[], end0: number, end1: number,
       radius: number, srcId: number, sp: Point): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.Poly);
    buf.writeLong(dstId);
    buf.writeShort(pts.length - 1);  // n = count - 1 (Plan 9 adds 1)
    buf.writeLong(end0);
    buf.writeLong(end1);
    buf.writeLong(radius);
    buf.writeLong(srcId);
    buf.writePoint(sp);
    // Points use drawcoord encoding
    let ox = 0, oy = 0;
    for (const pt of pts) {
      buf.writeCoord(pt.x, ox);
      buf.writeCoord(pt.y, oy);
      ox = pt.x;
      oy = pt.y;
    }
    return buf.toUint8Array();
  },

  // 'P' - FillPoly
  // P dstid[4] n[2] wind[4] ignore[2*4] srcid[4] sp[2*4] dp[variable]
  fillPoly(dstId: number, pts: Point[], wind: number, srcId: number, sp: Point): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.FillPoly);
    buf.writeLong(dstId);
    buf.writeShort(pts.length - 1);
    buf.writeLong(wind);
    buf.writeLong(0); // ignore (e0)
    buf.writeLong(0); // ignore (e1)
    buf.writeLong(srcId);
    buf.writePoint(sp);
    let ox = 0, oy = 0;
    for (const pt of pts) {
      buf.writeCoord(pt.x, ox);
      buf.writeCoord(pt.y, oy);
      ox = pt.x;
      oy = pt.y;
    }
    return buf.toUint8Array();
  },

  // 's' - String
  // s dstid[4] srcid[4] fontid[4] p[2*4] clipr[4*4] sp[2*4] n[2] indices[n*2]
  string(dstId: number, srcId: number, fontId: number, p: Point, clipr: Rectangle,
         sp: Point, indices: number[]): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.String);
    buf.writeLong(dstId);
    buf.writeLong(srcId);
    buf.writeLong(fontId);
    buf.writePoint(p);
    buf.writeRect(clipr);
    buf.writePoint(sp);
    buf.writeShort(indices.length);
    for (const idx of indices) {
      buf.writeShort(idx);
    }
    return buf.toUint8Array();
  },

  // 'x' - StringBg
  // x dstid[4] srcid[4] fontid[4] p[8] clipr[16] sp[8] ni[2] bgid[4] bgp[8] indices[ni*2]
  stringBg(dstId: number, srcId: number, fontId: number, p: Point, clipr: Rectangle,
           sp: Point, bgId: number, bgp: Point, indices: number[]): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.StringBg);
    buf.writeLong(dstId);
    buf.writeLong(srcId);
    buf.writeLong(fontId);
    buf.writePoint(p);
    buf.writeRect(clipr);
    buf.writePoint(sp);
    buf.writeShort(indices.length);
    buf.writeLong(bgId);
    buf.writePoint(bgp);
    for (const idx of indices) {
      buf.writeShort(idx);
    }
    return buf.toUint8Array();
  },

  // 'y' - Load (uncompressed)
  // y id[4] r[4*4] data[...]
  load(id: number, r: Rectangle, data: Uint8Array): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.Load);
    buf.writeLong(id);
    buf.writeRect(r);
    buf.writeBytes(data);
    return buf.toUint8Array();
  },

  // 'Y' - Load compressed
  loadCompressed(id: number, r: Rectangle, data: Uint8Array): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.LoadCompressed);
    buf.writeLong(id);
    buf.writeRect(r);
    buf.writeBytes(data);
    return buf.toUint8Array();
  },

  // 'r' - Unload (read)
  // r id[4] r[4*4]
  unload(id: number, r: Rectangle): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.Unload);
    buf.writeLong(id);
    buf.writeRect(r);
    return buf.toUint8Array();
  },

  // 'v' - Flush
  flush(): Uint8Array {
    return new Uint8Array([DrawCmd.Flush]);
  },

  // 'o' - Origin
  // o id[4] log[2*4] scr[2*4]
  origin(id: number, log: Point, scr: Point): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.Origin);
    buf.writeLong(id);
    buf.writePoint(log);
    buf.writePoint(scr);
    return buf.toUint8Array();
  },

  // 'c' - Set clip
  // c dstid[4] repl[1] clipR[4*4]
  setClip(dstId: number, repl: boolean, clipr: Rectangle): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.SetClip);
    buf.writeLong(dstId);
    buf.writeByte(repl ? 1 : 0);
    buf.writeRect(clipr);
    return buf.toUint8Array();
  },

  // 'O' - Set compositing operator
  // O op[1]
  setOp(op: DrawOp): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.SetOp);
    buf.writeByte(op);
    return buf.toUint8Array();
  },

  // 'A' - AllocScreen
  // A id[4] imageid[4] fillid[4] public[1]
  allocScreen(id: number, imageId: number, fillId: number, isPublic: boolean): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.AllocScreen);
    buf.writeLong(id);
    buf.writeLong(imageId);
    buf.writeLong(fillId);
    buf.writeByte(isPublic ? 1 : 0);
    return buf.toUint8Array();
  },

  // 'F' - FreeScreen
  freeScreen(id: number): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.FreeScreen);
    buf.writeLong(id);
    return buf.toUint8Array();
  },

  // 't' - Top
  // t n[2] id0[4] id1[4] ...
  top(ids: number[]): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.Top);
    buf.writeShort(ids.length);
    for (const id of ids) {
      buf.writeLong(id);
    }
    return buf.toUint8Array();
  },

  // 'B' - Bottom
  bottom(ids: number[]): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.Bottom);
    buf.writeShort(ids.length);
    for (const id of ids) {
      buf.writeLong(id);
    }
    return buf.toUint8Array();
  },

  // 'N' - Name image (global)
  // N id[4] in[1] j[1] name[j]
  nameImage(id: number, inFlag: boolean, name: string): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.NameImage);
    buf.writeLong(id);
    buf.writeByte(inFlag ? 1 : 0);
    buf.writeString(name);
    return buf.toUint8Array();
  },

  // 'n' - Name image (local)
  // n id[4] j[1] name[j]
  nameImageLocal(id: number, name: string): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.NameImageLocal);
    buf.writeLong(id);
    buf.writeString(name);
    return buf.toUint8Array();
  },

  // 'i' - Initialize font
  // i fontid[4] nchars[4] ascent[1]
  initFont(fontId: number, nchars: number, ascent: number): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.InitFont);
    buf.writeLong(fontId);
    buf.writeLong(nchars);
    buf.writeByte(ascent);
    return buf.toUint8Array();
  },

  // 'l' - Load character
  // l fontid[4] srcid[4] index[2] R[4*4] P[2*4] left[1] width[1]
  loadChar(fontId: number, srcId: number, index: number, r: Rectangle,
           p: Point, left: number, width: number): Uint8Array {
    const buf = new DrawBuffer();
    buf.writeByte(DrawCmd.LoadChar);
    buf.writeLong(fontId);
    buf.writeLong(srcId);
    buf.writeShort(index);
    buf.writeRect(r);
    buf.writePoint(p);
    buf.writeByte(left & 0xFF);
    buf.writeByte(width & 0xFF);
    return buf.toUint8Array();
  },

  // 'I' - Init
  init(): Uint8Array {
    return new Uint8Array([DrawCmd.Init]);
  },
};

// Parse ctl response (12 fields of 12 characters each)
export function parseCtl(data: string): {
  clientId: number;
  imageId: number;
  chan: string;
  repl: number;
  r: Rectangle;
  clipr: Rectangle;
} {
  // Each field is 11 chars right-justified + space = 12 chars
  // Total: 12 * 12 = 144 chars
  const fields: string[] = [];
  for (let i = 0; i < 12; i++) {
    fields.push(data.substring(i * 12, (i + 1) * 12).trim());
  }

  return {
    clientId: parseInt(fields[0], 10),
    imageId: parseInt(fields[1], 10),
    chan: fields[2],
    repl: parseInt(fields[3], 10),
    r: {
      minX: parseInt(fields[4], 10),
      minY: parseInt(fields[5], 10),
      maxX: parseInt(fields[6], 10),
      maxY: parseInt(fields[7], 10),
    },
    clipr: {
      minX: parseInt(fields[8], 10),
      minY: parseInt(fields[9], 10),
      maxX: parseInt(fields[10], 10),
      maxY: parseInt(fields[11], 10),
    },
  };
}
