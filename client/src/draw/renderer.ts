// Draw renderer - executes draw commands on HTML Canvas
// This is the client-side compositor that replaces Plan 9's devdraw

import {
  DrawCmd, DrawOp, Channel, Point, Rectangle,
  ClientImage, FontInfo, FontChar,
  rectWidth, rectHeight, rectIntersect, rectIsEmpty,
  channelDepth, parseChannel, parseFontchar,
} from './types.js';
import { DrawReader } from './protocol.js';

// Map DrawOp to Canvas globalCompositeOperation
const COMPOSITE_OPS: Record<DrawOp, GlobalCompositeOperation> = {
  [DrawOp.Clear]: 'destination-out',  // Approximation
  [DrawOp.SinD]: 'source-in',
  [DrawOp.DinS]: 'destination-in',
  [DrawOp.SoutD]: 'source-out',
  [DrawOp.DoutS]: 'destination-out',
  [DrawOp.S]: 'copy',
  [DrawOp.SoverD]: 'source-over',
  [DrawOp.SatopD]: 'source-atop',
  [DrawOp.SxorD]: 'xor',
  [DrawOp.D]: 'destination-over',  // Approximation
  [DrawOp.DoverS]: 'destination-over',
  [DrawOp.DatopS]: 'destination-atop',
};

export class DrawRenderer {
  // Image table - maps image IDs to images
  private images = new Map<number, ClientImage>();

  // Font table - maps font image IDs to font info
  private fonts = new Map<number, FontInfo>();

  // Screen canvas (the main display)
  private screenCanvas: HTMLCanvasElement;
  private screenCtx: CanvasRenderingContext2D;

  // Current compositing operator (reset to SoverD after each draw op)
  private currentOp: DrawOp = DrawOp.SoverD;

  // Refresh callback
  public onFlush?: (r: Rectangle) => void;

  // Pending refresh rectangles
  private refreshRects: Rectangle[] = [];

  // Next image ID for allocations
  private nextImageId = 1;

  // Use browser font fallback when font cache is empty
  public useFontFallback = true;

  // Fallback font family (monospace to match Plan 9 style)
  public fallbackFontFamily = 'monospace';

  constructor(canvas: HTMLCanvasElement) {
    this.screenCanvas = canvas;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Failed to get 2D context');
    this.screenCtx = ctx;

    // Initialize screen image (ID 0)
    this.images.set(0, {
      id: 0,
      width: canvas.width,
      height: canvas.height,
      chan: Channel.XRGB32,
      repl: false,
      r: { minX: 0, minY: 0, maxX: canvas.width, maxY: canvas.height },
      clipr: { minX: 0, minY: 0, maxX: canvas.width, maxY: canvas.height },
      screenId: 0,
      canvas: canvas as unknown as OffscreenCanvas, // TypeScript workaround
    });
  }

  // Get screen dimensions
  getScreenRect(): Rectangle {
    return {
      minX: 0,
      minY: 0,
      maxX: this.screenCanvas.width,
      maxY: this.screenCanvas.height,
    };
  }

  // Get channel format string
  getChannelString(): string {
    return 'x8r8g8b8';
  }

  // Resize screen
  resize(width: number, height: number): void {
    this.screenCanvas.width = width;
    this.screenCanvas.height = height;

    const screen = this.images.get(0)!;
    screen.width = width;
    screen.height = height;
    screen.r = { minX: 0, minY: 0, maxX: width, maxY: height };
    screen.clipr = { minX: 0, minY: 0, maxX: width, maxY: height };
  }

  // Process a batch of draw commands
  // Returns response data (may be empty)
  processCommands(data: Uint8Array): Uint8Array {
    const reader = new DrawReader(data);
    const responses: number[] = [];

    while (reader.remaining > 0) {
      const cmd = reader.readByte() as DrawCmd;
      const result = this.processCommand(cmd, reader);
      if (result) {
        responses.push(...result);
      }
    }

    return new Uint8Array(responses);
  }

  private processCommand(cmd: DrawCmd, reader: DrawReader): number[] | null {
    switch (cmd) {
      case DrawCmd.Alloc:
        return this.cmdAlloc(reader);
      case DrawCmd.Free:
        return this.cmdFree(reader);
      case DrawCmd.Draw:
        return this.cmdDraw(reader);
      case DrawCmd.Line:
        return this.cmdLine(reader);
      case DrawCmd.Ellipse:
        return this.cmdEllipse(reader, false);
      case DrawCmd.EllipseFill:
        return this.cmdEllipse(reader, true);
      case DrawCmd.Arc:
        return this.cmdArc(reader);
      case DrawCmd.Poly:
        return this.cmdPoly(reader);
      case DrawCmd.FillPoly:
        return this.cmdFillPoly(reader);
      case DrawCmd.String:
        return this.cmdString(reader, false);
      case DrawCmd.StringBg:
        return this.cmdString(reader, true);
      case DrawCmd.Load:
        return this.cmdLoad(reader, false);
      case DrawCmd.LoadCompressed:
        return this.cmdLoad(reader, true);
      case DrawCmd.Unload:
        return this.cmdUnload(reader);
      case DrawCmd.Flush:
        return this.cmdFlush();
      case DrawCmd.Origin:
        return this.cmdOrigin(reader);
      case DrawCmd.SetClip:
        return this.cmdSetClip(reader);
      case DrawCmd.SetOp:
        return this.cmdSetOp(reader);
      case DrawCmd.AllocScreen:
        return this.cmdAllocScreen(reader);
      case DrawCmd.FreeScreen:
        return this.cmdFreeScreen(reader);
      case DrawCmd.Top:
        return this.cmdTop(reader);
      case DrawCmd.Bottom:
        return this.cmdBottom(reader);
      case DrawCmd.NameImage:
        return this.cmdNameImage(reader);
      case DrawCmd.NameImageLocal:
        return this.cmdNameImageLocal(reader);
      case DrawCmd.InitFont:
        return this.cmdInitFont(reader);
      case DrawCmd.LoadChar:
        return this.cmdLoadChar(reader);
      case DrawCmd.Init:
        return this.cmdInit();
      default:
        console.error(`Unknown draw command: ${cmd} (0x${cmd.toString(16)})`);
        throw new Error(`Unknown draw command: ${cmd}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Command implementations
  // ─────────────────────────────────────────────────────────────

  // 'b' - Allocate image
  private cmdAlloc(reader: DrawReader): null {
    const id = reader.readLong();
    const screenId = reader.readLong();
    const refresh = reader.readByte();
    const chan = reader.readULong();
    const repl = reader.readByte() !== 0;
    const r = reader.readRect();
    const clipr = reader.readRect();
    const color = reader.readULong();

    const width = rectWidth(r);
    const height = rectHeight(r);

    // Create offscreen canvas for this image
    const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    const ctx = canvas.getContext('2d')!;

    // Fill with color
    const a = ((color >> 24) & 0xFF) / 255;
    const r_ = (color >> 16) & 0xFF;
    const g = (color >> 8) & 0xFF;
    const b = color & 0xFF;
    ctx.fillStyle = `rgba(${r_}, ${g}, ${b}, ${a})`;
    ctx.fillRect(0, 0, width, height);

    this.images.set(id, {
      id,
      width,
      height,
      chan,
      repl,
      r,
      clipr,
      screenId,
      canvas,
    });

    return null;
  }

  // 'f' - Free image
  private cmdFree(reader: DrawReader): null {
    const id = reader.readLong();
    if (id !== 0) {  // Can't free screen image
      this.images.delete(id);
      this.fonts.delete(id);
    }
    return null;
  }

  // 'd' - Draw (blit)
  private cmdDraw(reader: DrawReader): null {
    const dstId = reader.readLong();
    const srcId = reader.readLong();
    const maskId = reader.readLong();
    const r = reader.readRect();
    const sp = reader.readPoint();
    const mp = reader.readPoint();

    const dst = this.getImage(dstId);
    const src = this.getImage(srcId);
    const mask = maskId !== 0 ? this.getImage(maskId) : null;

    const ctx = this.getContext(dst);
    const op = this.getOp();

    ctx.save();
    ctx.globalCompositeOperation = COMPOSITE_OPS[op] || 'source-over';

    // Translate destination to image coordinates
    const dstX = r.minX - dst.r.minX;
    const dstY = r.minY - dst.r.minY;
    const width = rectWidth(r);
    const height = rectHeight(r);

    // Source coordinates
    const srcX = sp.x - src.r.minX;
    const srcY = sp.y - src.r.minY;

    if (mask) {
      // Draw with mask: use mask as alpha channel
      const maskX = mp.x - mask.r.minX;
      const maskY = mp.y - mask.r.minY;

      // Create temporary canvas for masked drawing
      const temp = new OffscreenCanvas(width, height);
      const tempCtx = temp.getContext('2d')!;

      // Draw source
      const srcCanvas = this.getCanvas(src);
      tempCtx.drawImage(srcCanvas, srcX, srcY, width, height, 0, 0, width, height);

      // Apply mask
      tempCtx.globalCompositeOperation = 'destination-in';
      const maskCanvas = this.getCanvas(mask);
      tempCtx.drawImage(maskCanvas, maskX, maskY, width, height, 0, 0, width, height);

      // Draw to destination
      ctx.drawImage(temp, 0, 0, width, height, dstX, dstY, width, height);
    } else {
      // Simple blit
      const srcCanvas = this.getCanvas(src);
      ctx.drawImage(srcCanvas, srcX, srcY, width, height, dstX, dstY, width, height);
    }

    ctx.restore();
    this.addRefresh(dstId, r);
    return null;
  }

  // 'L' - Line
  private cmdLine(reader: DrawReader): null {
    const dstId = reader.readLong();
    const p0 = reader.readPoint();
    const p1 = reader.readPoint();
    const end0 = reader.readLong();
    const end1 = reader.readLong();
    const radius = reader.readLong();
    const srcId = reader.readLong();
    const sp = reader.readPoint();

    const dst = this.getImage(dstId);
    const src = this.getImage(srcId);
    const ctx = this.getContext(dst);
    const op = this.getOp();

    ctx.save();
    ctx.globalCompositeOperation = COMPOSITE_OPS[op] || 'source-over';

    // Get source color (sample from source image)
    const color = this.sampleColor(src, sp);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, radius * 2);
    ctx.lineCap = this.getLineCap(end0);

    // Translate to image coordinates
    const x0 = p0.x - dst.r.minX;
    const y0 = p0.y - dst.r.minY;
    const x1 = p1.x - dst.r.minX;
    const y1 = p1.y - dst.r.minY;

    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();

    ctx.restore();

    // Calculate bounding box
    const t = radius;
    const bbox: Rectangle = {
      minX: Math.min(p0.x, p1.x) - t - 1,
      minY: Math.min(p0.y, p1.y) - t - 1,
      maxX: Math.max(p0.x, p1.x) + t + 2,
      maxY: Math.max(p0.y, p1.y) + t + 2,
    };
    this.addRefresh(dstId, bbox);
    return null;
  }

  // 'e'/'E' - Ellipse/Filled Ellipse
  private cmdEllipse(reader: DrawReader, filled: boolean): null {
    const dstId = reader.readLong();
    const srcId = reader.readLong();
    const center = reader.readPoint();
    const a = reader.readLong();  // x radius
    const b = reader.readLong();  // y radius
    const thick = reader.readLong();
    const sp = reader.readPoint();
    const alpha = reader.readLong();  // arc angle (unused for full ellipse)
    const phi = reader.readLong();    // arc start (unused for full ellipse)

    const dst = this.getImage(dstId);
    const src = this.getImage(srcId);
    const ctx = this.getContext(dst);
    const op = this.getOp();

    ctx.save();
    ctx.globalCompositeOperation = COMPOSITE_OPS[op] || 'source-over';

    const color = this.sampleColor(src, sp);
    const cx = center.x - dst.r.minX;
    const cy = center.y - dst.r.minY;

    ctx.beginPath();
    ctx.ellipse(cx, cy, a, b, 0, 0, Math.PI * 2);

    if (filled || thick < 0) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, thick);
      ctx.stroke();
    }

    ctx.restore();

    const t = filled ? 0 : thick;
    const bbox: Rectangle = {
      minX: center.x - a - t - 1,
      minY: center.y - b - t - 1,
      maxX: center.x + a + t + 2,
      maxY: center.y + b + t + 2,
    };
    this.addRefresh(dstId, bbox);
    return null;
  }

  // 'a' - Arc
  private cmdArc(reader: DrawReader): null {
    const dstId = reader.readLong();
    const srcId = reader.readLong();
    const center = reader.readPoint();
    const a = reader.readLong();
    const b = reader.readLong();
    const thick = reader.readLong();
    const sp = reader.readPoint();
    const alpha = reader.readLong();  // arc extent (in degrees * 64)
    const phi = reader.readLong();    // arc start (in degrees * 64)

    const dst = this.getImage(dstId);
    const src = this.getImage(srcId);
    const ctx = this.getContext(dst);
    const op = this.getOp();

    ctx.save();
    ctx.globalCompositeOperation = COMPOSITE_OPS[op] || 'source-over';

    const color = this.sampleColor(src, sp);
    const cx = center.x - dst.r.minX;
    const cy = center.y - dst.r.minY;

    // Convert Plan 9 angles (degrees * 64) to radians
    const startAngle = (phi / 64) * (Math.PI / 180);
    const endAngle = startAngle + (alpha / 64) * (Math.PI / 180);

    ctx.beginPath();
    ctx.ellipse(cx, cy, a, b, 0, startAngle, endAngle);

    if (thick < 0) {
      // Filled arc (pie slice)
      ctx.lineTo(cx, cy);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, thick);
      ctx.stroke();
    }

    ctx.restore();

    const t = Math.abs(thick);
    const bbox: Rectangle = {
      minX: center.x - a - t - 1,
      minY: center.y - b - t - 1,
      maxX: center.x + a + t + 2,
      maxY: center.y + b + t + 2,
    };
    this.addRefresh(dstId, bbox);
    return null;
  }

  // 'p' - Poly (outline)
  private cmdPoly(reader: DrawReader): null {
    const dstId = reader.readLong();
    const n = reader.readShort();
    const end0 = reader.readLong();
    const end1 = reader.readLong();
    const radius = reader.readLong();
    const srcId = reader.readLong();
    const sp = reader.readPoint();

    // Read points (n + 1 total)
    const pts: Point[] = [];
    let ox = 0, oy = 0;
    for (let i = 0; i <= n; i++) {
      const x = reader.readCoord(ox);
      const y = reader.readCoord(oy);
      pts.push({ x, y });
      ox = x;
      oy = y;
    }

    const dst = this.getImage(dstId);
    const src = this.getImage(srcId);
    const ctx = this.getContext(dst);
    const op = this.getOp();

    ctx.save();
    ctx.globalCompositeOperation = COMPOSITE_OPS[op] || 'source-over';

    const color = this.sampleColor(src, sp);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, radius * 2);
    ctx.lineCap = this.getLineCap(end0);
    ctx.lineJoin = 'round';

    ctx.beginPath();
    const first = pts[0];
    ctx.moveTo(first.x - dst.r.minX, first.y - dst.r.minY);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x - dst.r.minX, pts[i].y - dst.r.minY);
    }
    ctx.stroke();

    ctx.restore();

    // Bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of pts) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
    this.addRefresh(dstId, {
      minX: minX - radius - 1,
      minY: minY - radius - 1,
      maxX: maxX + radius + 2,
      maxY: maxY + radius + 2,
    });
    return null;
  }

  // 'P' - FillPoly
  private cmdFillPoly(reader: DrawReader): null {
    const dstId = reader.readLong();
    const n = reader.readShort();
    const wind = reader.readLong();
    reader.readLong();  // ignored (e0)
    reader.readLong();  // ignored (e1)
    const srcId = reader.readLong();
    const sp = reader.readPoint();

    const pts: Point[] = [];
    let ox = 0, oy = 0;
    for (let i = 0; i <= n; i++) {
      const x = reader.readCoord(ox);
      const y = reader.readCoord(oy);
      pts.push({ x, y });
      ox = x;
      oy = y;
    }

    const dst = this.getImage(dstId);
    const src = this.getImage(srcId);
    const ctx = this.getContext(dst);
    const op = this.getOp();

    ctx.save();
    ctx.globalCompositeOperation = COMPOSITE_OPS[op] || 'source-over';

    const color = this.sampleColor(src, sp);
    ctx.fillStyle = color;

    ctx.beginPath();
    const first = pts[0];
    ctx.moveTo(first.x - dst.r.minX, first.y - dst.r.minY);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x - dst.r.minX, pts[i].y - dst.r.minY);
    }
    ctx.closePath();
    ctx.fill(wind === 0 ? 'evenodd' : 'nonzero');

    ctx.restore();

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of pts) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
    this.addRefresh(dstId, { minX, minY, maxX: maxX + 1, maxY: maxY + 1 });
    return null;
  }

  // 's'/'x' - String/StringBg
  // s dstid[4] srcid[4] fontid[4] p[2*4] clipr[4*4] sp[2*4] n[2] indices[n*2]
  // x dstid[4] srcid[4] fontid[4] p[2*4] clipr[4*4] sp[2*4] ni[2] bgid[4] bgp[2*4] indices[ni*2]
  private cmdString(reader: DrawReader, hasBg: boolean): number[] {
    const dstId = reader.readLong();
    const srcId = reader.readLong();
    const fontId = reader.readLong();
    const p = reader.readPoint();
    const clipr = reader.readRect();
    const sp = reader.readPoint();
    const n = reader.readShort();

    let bgId = 0, bgp: Point = { x: 0, y: 0 };
    if (hasBg) {
      bgId = reader.readLong();
      bgp = reader.readPoint();
    }

    // Read cache indices
    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
      indices.push(reader.readShort());
    }

    const dst = this.getImage(dstId);
    const src = this.getImage(srcId);
    const font = this.fonts.get(fontId);
    const op = this.getOp();

    // Check if font has loaded glyphs
    const fontHasGlyphs = font && this.fontHasLoadedGlyphs(font);

    // If no font or no glyphs loaded, try browser fallback
    if (!fontHasGlyphs && this.useFontFallback) {
      return this.drawStringFallback(dst, src, font, p, clipr, sp, indices, hasBg, bgId, bgp, op);
    }

    // If font not found and no fallback, just return the point unchanged
    if (!font) {
      return this.encodePoint(p);
    }

    const ctx = this.getContext(dst);
    ctx.save();

    // Set clipping region
    ctx.beginPath();
    ctx.rect(
      clipr.minX - dst.r.minX,
      clipr.minY - dst.r.minY,
      rectWidth(clipr),
      rectHeight(clipr)
    );
    ctx.clip();

    ctx.globalCompositeOperation = COMPOSITE_OPS[op] || 'source-over';

    // Draw background if present
    if (hasBg && bgId !== 0) {
      const bg = this.getImage(bgId);
      let totalWidth = 0;
      for (const idx of indices) {
        if (idx < font.chars.length) {
          totalWidth += font.chars[idx].width;
        }
      }

      const bgColor = this.sampleColor(bg, bgp);
      ctx.fillStyle = bgColor;
      ctx.fillRect(
        p.x - dst.r.minX,
        p.y - font.ascent - dst.r.minY,
        totalWidth,
        font.height
      );
    }

    // Draw each character using font cache
    const fontImage = this.getImage(fontId);
    const fontCanvas = this.getCanvas(fontImage);

    let curX = p.x - dst.r.minX;
    const baseY = p.y - dst.r.minY;

    for (const idx of indices) {
      if (idx >= font.n) continue;
      const fc = font.chars[idx];
      if (fc.width === 0) continue;

      // Glyph width is distance to next char's x position (sentinel pattern)
      const fcNext = font.chars[idx + 1];
      const glyphWidth = fcNext.x - fc.x;
      const glyphHeight = fc.bottom - fc.top;

      if (glyphWidth > 0 && glyphHeight > 0) {
        // Destination position
        const dstX = curX + fc.left;
        const dstY = baseY - font.ascent + fc.top;

        // Source position in font image (font image coords start at 0)
        const srcX = fc.x - fontImage.r.minX;
        const srcY = fc.top - fontImage.r.minY;

        // Draw using font image as mask with src color
        // For proper masking, we use the font glyph alpha channel
        ctx.drawImage(
          fontCanvas,
          srcX, srcY, glyphWidth, glyphHeight,
          dstX, dstY, glyphWidth, glyphHeight
        );
      }

      curX += fc.width;
    }

    ctx.restore();

    // Return end point (in dst coordinates)
    const endX = curX + dst.r.minX;
    this.addRefresh(dstId, {
      minX: p.x,
      minY: p.y - font.ascent,
      maxX: endX,
      maxY: p.y + font.height - font.ascent,
    });

    return this.encodePoint({ x: endX, y: p.y });
  }

  // Check if a font has any loaded glyphs (not just initialized)
  private fontHasLoadedGlyphs(font: FontInfo): boolean {
    // Check if any character has non-zero dimensions
    for (let i = 0; i < Math.min(font.n, font.chars.length - 1); i++) {
      const fc = font.chars[i];
      const fcNext = font.chars[i + 1];
      if (fc.width > 0 && fcNext.x > fc.x) {
        return true;
      }
    }
    return false;
  }

  // Browser font fallback - use Canvas fillText when font cache is empty
  private drawStringFallback(
    dst: ClientImage,
    src: ClientImage,
    font: FontInfo | undefined,
    p: Point,
    clipr: Rectangle,
    sp: Point,
    indices: number[],
    hasBg: boolean,
    bgId: number,
    bgp: Point,
    op: DrawOp
  ): number[] {
    const ctx = this.getContext(dst);
    ctx.save();

    // Set clipping region
    ctx.beginPath();
    ctx.rect(
      clipr.minX - dst.r.minX,
      clipr.minY - dst.r.minY,
      rectWidth(clipr),
      rectHeight(clipr)
    );
    ctx.clip();

    ctx.globalCompositeOperation = COMPOSITE_OPS[op] || 'source-over';

    // Determine font size from font info or default
    const fontSize = font ? font.height : 14;
    const ascent = font ? font.ascent : Math.round(fontSize * 0.8);

    ctx.font = `${fontSize}px ${this.fallbackFontFamily}`;
    ctx.textBaseline = 'alphabetic';

    // Convert indices to string (indices are typically Unicode codepoints or ASCII)
    const text = String.fromCharCode(...indices);

    // Get text metrics for width calculation
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;

    const dstX = p.x - dst.r.minX;
    const dstY = p.y - dst.r.minY;

    // Draw background if present
    if (hasBg && bgId !== 0) {
      const bg = this.getImage(bgId);
      const bgColor = this.sampleColor(bg, bgp);
      ctx.fillStyle = bgColor;
      ctx.fillRect(dstX, dstY - ascent, textWidth, fontSize);
    }

    // Get text color from src image
    const textColor = this.sampleColor(src, sp);
    ctx.fillStyle = textColor;

    // Draw text
    ctx.fillText(text, dstX, dstY);

    ctx.restore();

    // Return end point
    const endX = p.x + Math.round(textWidth);
    this.addRefresh(dst.id, {
      minX: p.x,
      minY: p.y - ascent,
      maxX: endX,
      maxY: p.y + fontSize - ascent,
    });

    return this.encodePoint({ x: endX, y: p.y });
  }

  // 'y'/'Y' - Load pixel data
  private cmdLoad(reader: DrawReader, compressed: boolean): number[] {
    const id = reader.readLong();
    const r = reader.readRect();

    const img = this.getImage(id);
    const ctx = this.getContext(img);

    const width = rectWidth(r);
    const height = rectHeight(r);

    // Read remaining data (pixel data goes to end of buffer for 'y', or has explicit length for 'Y')
    let pixelData: Uint8Array;
    if (compressed) {
      // For compressed, data goes to end - decompress it
      pixelData = this.decompressPixels(reader.readBytes(reader.remaining), width, height, img.chan);
    } else {
      pixelData = reader.readBytes(reader.remaining);
    }

    // Convert Plan 9 pixel data to RGBA ImageData
    const imageData = this.convertToRGBA(pixelData, width, height, img.chan);

    // Draw to canvas
    const dstX = r.minX - img.r.minX;
    const dstY = r.minY - img.r.minY;
    ctx.putImageData(imageData, dstX, dstY);

    this.addRefresh(id, r);

    // Return count of bytes consumed
    return this.encodeLong(pixelData.length);
  }

  // 'r' - Unload (read pixel data)
  private cmdUnload(reader: DrawReader): number[] {
    const id = reader.readLong();
    const r = reader.readRect();

    const img = this.getImage(id);
    const ctx = this.getContext(img);

    const width = rectWidth(r);
    const height = rectHeight(r);

    const srcX = r.minX - img.r.minX;
    const srcY = r.minY - img.r.minY;

    const imageData = ctx.getImageData(srcX, srcY, width, height);

    // Convert from RGBA to Plan 9 format
    return Array.from(this.convertFromRGBA(imageData, img.chan));
  }

  // 'v' - Flush
  private cmdFlush(): null {
    // Combine refresh rectangles and trigger callback
    if (this.refreshRects.length > 0 && this.onFlush) {
      // Combine into bounding box
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const r of this.refreshRects) {
        if (r.minX < minX) minX = r.minX;
        if (r.minY < minY) minY = r.minY;
        if (r.maxX > maxX) maxX = r.maxX;
        if (r.maxY > maxY) maxY = r.maxY;
      }
      this.onFlush({ minX, minY, maxX, maxY });
    }
    this.refreshRects = [];
    return null;
  }

  // 'o' - Origin
  private cmdOrigin(reader: DrawReader): null {
    const id = reader.readLong();
    const log = reader.readPoint();
    const scr = reader.readPoint();
    // TODO: Implement origin adjustment
    return null;
  }

  // 'c' - Set clip
  private cmdSetClip(reader: DrawReader): null {
    const dstId = reader.readLong();
    const repl = reader.readByte() !== 0;
    const clipr = reader.readRect();

    const img = this.images.get(dstId);
    if (img) {
      img.repl = repl;
      img.clipr = clipr;
    }
    return null;
  }

  // 'O' - Set compositing operator
  private cmdSetOp(reader: DrawReader): null {
    this.currentOp = reader.readByte() as DrawOp;
    return null;
  }

  // 'A' - AllocScreen
  private cmdAllocScreen(reader: DrawReader): null {
    const id = reader.readLong();
    const imageId = reader.readLong();
    const fillId = reader.readLong();
    const isPublic = reader.readByte() !== 0;
    // Screens are mostly for layering - we can handle this later
    return null;
  }

  // 'F' - FreeScreen
  private cmdFreeScreen(reader: DrawReader): null {
    const id = reader.readLong();
    return null;
  }

  // 't' - Top
  private cmdTop(reader: DrawReader): null {
    const n = reader.readShort();
    for (let i = 0; i < n; i++) {
      reader.readLong();  // id
    }
    return null;
  }

  // 'B' - Bottom
  private cmdBottom(reader: DrawReader): null {
    const n = reader.readShort();
    for (let i = 0; i < n; i++) {
      reader.readLong();
    }
    return null;
  }

  // 'N' - Name image (global)
  private cmdNameImage(reader: DrawReader): null {
    const dstId = reader.readLong();
    const inFlag = reader.readByte();
    const name = reader.readString();

    // Create reference to screen for named images
    if (!this.images.has(dstId)) {
      const screen = this.images.get(0)!;
      this.images.set(dstId, { ...screen, id: dstId });
    }
    return null;
  }

  // 'n' - Name image (local)
  private cmdNameImageLocal(reader: DrawReader): null {
    const dstId = reader.readLong();
    const name = reader.readString();

    if (!this.images.has(dstId)) {
      const screen = this.images.get(0)!;
      this.images.set(dstId, { ...screen, id: dstId });
    }
    return null;
  }

  // 'i' - Initialize font
  private cmdInitFont(reader: DrawReader): null {
    const fontId = reader.readLong();
    const nchars = reader.readLong();
    const ascent = reader.readByte();

    if (!this.images.has(fontId)) {
      throw new Error(`Font image ${fontId} not found`);
    }

    // Create n+1 chars (last is sentinel for width calculation)
    this.fonts.set(fontId, {
      id: fontId,
      n: nchars,
      ascent,
      height: ascent,  // Will be updated as chars are loaded
      chars: new Array(nchars + 1).fill(null).map(() => ({
        x: 0,
        top: 0,
        bottom: 0,
        left: 0,
        width: 0,
      })),
    });
    return null;
  }

  // 'l' - Load character
  // l fontid[4] srcid[4] index[2] R[4*4] P[2*4] left[1] width[1]
  private cmdLoadChar(reader: DrawReader): null {
    const fontId = reader.readLong();
    const srcId = reader.readLong();
    const index = reader.readShort();
    const r = reader.readRect();
    const p = reader.readPoint();
    const left = reader.readByte();
    const width = reader.readByte();

    const font = this.fonts.get(fontId);
    if (!font || index >= font.n) {
      return null;
    }

    const fontImage = this.getImage(fontId);
    const src = this.getImage(srcId);

    // Copy glyph from src to font image
    const srcCtx = this.getContext(src);
    const fontCtx = this.getContext(fontImage);

    const glyphWidth = rectWidth(r);
    const glyphHeight = rectHeight(r);
    const srcX = p.x - src.r.minX;
    const srcY = p.y - src.r.minY;
    const dstX = r.minX - fontImage.r.minX;
    const dstY = r.minY - fontImage.r.minY;

    if (glyphWidth > 0 && glyphHeight > 0) {
      const imageData = srcCtx.getImageData(srcX, srcY, glyphWidth, glyphHeight);
      fontCtx.putImageData(imageData, dstX, dstY);
    }

    // Update character metrics using Plan 9 Fontchar format
    // x = position in font image, top/bottom relative to baseline
    font.chars[index] = {
      x: r.minX,
      top: r.minY,
      bottom: r.maxY,
      left: (left > 127 ? left - 256 : left),  // signed byte
      width,
    };

    // Update sentinel (next char's x position for width calculation)
    if (index + 1 <= font.n) {
      font.chars[index + 1].x = r.maxX;
    }

    // Update font height (max bottom)
    if (r.maxY > font.height) {
      font.height = r.maxY;
    }

    return null;
  }

  // 'I' - Init
  private cmdInit(): number[] {
    // Return display info: id[4] chan[4] label[128] r[4*4]
    const response: number[] = [];

    // id = 0
    response.push(...this.encodeLong(0));
    // chan = XRGB32
    response.push(...this.encodeLong(Channel.XRGB32));
    // label (128 bytes, null-padded)
    const label = new TextEncoder().encode('enoch');
    for (let i = 0; i < 128; i++) {
      response.push(i < label.length ? label[i] : 0);
    }
    // rectangle
    const screen = this.images.get(0)!;
    response.push(...this.encodeLong(screen.r.minX));
    response.push(...this.encodeLong(screen.r.minY));
    response.push(...this.encodeLong(screen.r.maxX));
    response.push(...this.encodeLong(screen.r.maxY));

    return response;
  }

  // ─────────────────────────────────────────────────────────────
  // Helper methods
  // ─────────────────────────────────────────────────────────────

  private getImage(id: number): ClientImage {
    const img = this.images.get(id);
    if (!img) throw new Error(`Image ${id} not found`);
    return img;
  }

  private getContext(img: ClientImage): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
    if (img.id === 0) {
      return this.screenCtx;
    }
    if (!img.canvas) {
      throw new Error(`Image ${img.id} has no canvas`);
    }
    return img.canvas.getContext('2d')!;
  }

  private getCanvas(img: ClientImage): HTMLCanvasElement | OffscreenCanvas {
    if (img.id === 0) {
      return this.screenCanvas;
    }
    if (!img.canvas) {
      throw new Error(`Image ${img.id} has no canvas`);
    }
    return img.canvas;
  }

  private getOp(): DrawOp {
    const op = this.currentOp;
    this.currentOp = DrawOp.SoverD;  // Reset to default
    return op;
  }

  private getLineCap(end: number): CanvasLineCap {
    switch (end & 0x1F) {
      case 0: return 'butt';
      case 1: return 'round';
      default: return 'butt';
    }
  }

  private sampleColor(img: ClientImage, p: Point): string {
    // For solid color images, extract the color
    const ctx = this.getContext(img);
    const x = Math.max(0, Math.min(p.x - img.r.minX, img.width - 1));
    const y = Math.max(0, Math.min(p.y - img.r.minY, img.height - 1));

    try {
      const pixel = ctx.getImageData(x, y, 1, 1).data;
      return `rgba(${pixel[0]}, ${pixel[1]}, ${pixel[2]}, ${pixel[3] / 255})`;
    } catch {
      return 'black';
    }
  }

  private addRefresh(imageId: number, r: Rectangle): void {
    if (imageId === 0) {
      this.refreshRects.push(r);
    }
  }

  private convertToRGBA(data: Uint8Array, width: number, height: number, chan: number): ImageData {
    const imageData = new ImageData(width, height);
    const out = imageData.data;

    // Handle common formats
    switch (chan) {
      case Channel.XRGB32:
      case Channel.ARGB32: {
        // Plan 9 XRGB32/ARGB32: x/a r g b (big-endian word order but stored as bytes)
        for (let i = 0, j = 0; i < data.length && j < out.length; i += 4, j += 4) {
          out[j + 0] = data[i + 1]; // R
          out[j + 1] = data[i + 2]; // G
          out[j + 2] = data[i + 3]; // B
          out[j + 3] = chan === Channel.ARGB32 ? data[i + 0] : 255; // A
        }
        break;
      }
      case Channel.RGBA32: {
        // r g b a
        for (let i = 0, j = 0; i < data.length && j < out.length; i += 4, j += 4) {
          out[j + 0] = data[i + 0]; // R
          out[j + 1] = data[i + 1]; // G
          out[j + 2] = data[i + 2]; // B
          out[j + 3] = data[i + 3]; // A
        }
        break;
      }
      case Channel.RGB24: {
        for (let i = 0, j = 0; i < data.length && j < out.length; i += 3, j += 4) {
          out[j + 0] = data[i + 0]; // R
          out[j + 1] = data[i + 1]; // G
          out[j + 2] = data[i + 2]; // B
          out[j + 3] = 255;
        }
        break;
      }
      case Channel.GREY8: {
        for (let i = 0, j = 0; i < data.length && j < out.length; i++, j += 4) {
          out[j + 0] = out[j + 1] = out[j + 2] = data[i];
          out[j + 3] = 255;
        }
        break;
      }
      default: {
        // Assume XRGB32 as fallback
        for (let i = 0, j = 0; i < data.length && j < out.length; i += 4, j += 4) {
          out[j + 0] = data[i + 1];
          out[j + 1] = data[i + 2];
          out[j + 2] = data[i + 3];
          out[j + 3] = 255;
        }
      }
    }

    return imageData;
  }

  private convertFromRGBA(imageData: ImageData, chan: number): Uint8Array {
    const data = imageData.data;
    const depth = channelDepth(chan);
    const bytesPerPixel = Math.ceil(depth / 8);
    const out = new Uint8Array((imageData.width * imageData.height * depth + 7) / 8);

    switch (chan) {
      case Channel.XRGB32:
      case Channel.ARGB32: {
        for (let i = 0, j = 0; i < data.length; i += 4, j += 4) {
          out[j + 0] = chan === Channel.ARGB32 ? data[i + 3] : 0xFF;
          out[j + 1] = data[i + 0];
          out[j + 2] = data[i + 1];
          out[j + 3] = data[i + 2];
        }
        break;
      }
      case Channel.GREY8: {
        for (let i = 0, j = 0; i < data.length; i += 4, j++) {
          out[j] = Math.round((data[i] + data[i + 1] + data[i + 2]) / 3);
        }
        break;
      }
      default: {
        // XRGB32 fallback
        for (let i = 0, j = 0; i < data.length; i += 4, j += 4) {
          out[j + 0] = 0xFF;
          out[j + 1] = data[i + 0];
          out[j + 2] = data[i + 1];
          out[j + 3] = data[i + 2];
        }
      }
    }

    return out;
  }

  private decompressPixels(data: Uint8Array, width: number, height: number, chan: number): Uint8Array {
    // Plan 9 compressed pixel format (simple RLE)
    // This is a simplified version - full implementation would handle all cases
    const depth = channelDepth(chan);
    const bytesPerRow = (width * depth + 7) / 8;
    const out = new Uint8Array(bytesPerRow * height);

    let inPos = 0;
    let outPos = 0;

    while (inPos < data.length && outPos < out.length) {
      const cmd = data[inPos++];

      if (cmd >= 128) {
        // Literal run: 1 + (cmd - 128) bytes
        const count = 1 + (cmd - 128);
        for (let i = 0; i < count && inPos < data.length && outPos < out.length; i++) {
          out[outPos++] = data[inPos++];
        }
      } else {
        // Repeat run: 1 + cmd copies of next byte
        const count = 1 + cmd;
        const value = data[inPos++];
        for (let i = 0; i < count && outPos < out.length; i++) {
          out[outPos++] = value;
        }
      }
    }

    return out;
  }

  private encodeLong(v: number): number[] {
    return [
      v & 0xFF,
      (v >> 8) & 0xFF,
      (v >> 16) & 0xFF,
      (v >> 24) & 0xFF,
    ];
  }

  private encodePoint(p: Point): number[] {
    return [...this.encodeLong(p.x), ...this.encodeLong(p.y)];
  }
}
