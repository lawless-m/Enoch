# Phase 3: Graphics

Implement /dev/draw, /dev/mouse, and /dev/cons (graphical mode) for full CPU client functionality.

## Goal

A graphical client comparable to drawterm:
- Render Plan 9 graphics via Canvas API
- Handle mouse input
- Handle keyboard input
- Support window resize

## Plan 9 Graphics Model

Plan 9 uses a server-side display model:
- **Images** are allocated on the server (here, in browser memory)
- **Draw commands** operate on images by ID
- **The screen** is just another image

This maps well to Canvas, which also uses a retained drawing model.

## Device Files

| Device | Purpose |
|--------|---------|
| /dev/draw/new | Allocate connection, get connection ID |
| /dev/draw/N/ctl | Control: allocate images, set properties |
| /dev/draw/N/data | Draw commands |
| /dev/draw/N/refresh | Damage notification |
| /dev/mouse | Mouse position and button state |
| /dev/cons | Keyboard input (text mode or raw) |

Where N is the connection ID.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Browser                                │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │                       <canvas>                             │ │
│  └────────────────────────────┬──────────────────────────────┘ │
│                               │                                 │
│  ┌────────────────────────────┴──────────────────────────────┐ │
│  │                     draw.ts                                │ │
│  │  ┌────────────────────────────────────────────────────┐   │ │
│  │  │               Image Table                           │   │ │
│  │  │  id → { canvas, ctx, r, clipr, repl, ... }         │   │ │
│  │  └────────────────────────────────────────────────────┘   │ │
│  │                                                            │ │
│  │  ┌────────────────────────────────────────────────────┐   │ │
│  │  │           Command Interpreter                       │   │ │
│  │  │  'A' alloc  'f' free  'd' draw  'e' ellipse  ...   │   │ │
│  │  └────────────────────────────────────────────────────┘   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                               │                                 │
│  ┌────────────────────────────┴──────────────────────────────┐ │
│  │                     mouse.ts                               │ │
│  │  Canvas events → Plan 9 mouse format → Twrite             │ │
│  └────────────────────────────────────────────────────────────┘ │
│                               │                                 │
│  ┌────────────────────────────┴──────────────────────────────┐ │
│  │                      cons.ts                               │ │
│  │  Keyboard events → Plan 9 format → Twrite                 │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## /dev/draw Protocol

### Initialization

1. Open `/dev/draw/new`, read to get connection ID
2. Open `/dev/draw/N/ctl` for control operations
3. Open `/dev/draw/N/data` for draw commands

### Image Allocation (ctl)

Write to ctl to allocate images:

```
b id screenid refresh
```

Allocate screen image (id 0 is special):
```
screenid R min.x min.y max.x max.y
```

### Draw Commands (data)

Commands are single-character opcodes followed by binary parameters.

**Key commands:**

| Op | Name | Parameters | Description |
|----|------|------------|-------------|
| A | allocate | id, screenid, refresh, chan, repl, R, clipR, color | Allocate image |
| b | allocscreen | screenid, id, fillid, public | Allocate screen |
| d | draw | dstid, srcid, maskid, dst.R, src.pt, mask.pt | General draw |
| D | debug | bool | Toggle debug |
| e | ellipse | dstid, srcid, c, a, b, thick, sp, alpha, phi | Draw ellipse |
| E | fillellipse | dstid, srcid, c, a, b, sp | Fill ellipse |
| f | free | id | Free image |
| l | line | dstid, srcid, p0, p1, end0, end1, thick, sp | Draw line |
| L | loadimage | id, R, data | Load pixel data |
| n | origin | id, log, scr | Set origin |
| o | setop | op | Set compositing op |
| p | poly | dstid, srcid, n, pts[], end0, end1, thick, sp | Polygon |
| P | fillpoly | dstid, srcid, n, pts[], wind, sp | Fill polygon |
| r | readimage | id, R | Read pixels |
| s | string | dstid, srcid, fontid, pt, clipR, sp, str | Draw string |
| S | stringbg | dstid, srcid, fontid, pt, clipR, sp, str, bgid, bgpt | String with bg |
| t | top | n, ids[] | Bring to front |
| v | flush | | Flush to screen |
| x | stringwidth | fontid, str | Measure string |
| y | readstr | fontid | Read font info |

### Point and Rectangle Encoding

**Point (8 bytes):**
```
┌─────────┬─────────┐
│  x[4]   │  y[4]   │
│ (LE i32)│ (LE i32)│
└─────────┴─────────┘
```

**Rectangle (16 bytes):**
```
┌─────────┬─────────┬─────────┬─────────┐
│ min.x[4]│ min.y[4]│ max.x[4]│ max.y[4]│
└─────────┴─────────┴─────────┴─────────┘
```

### Channel Descriptors

Image format is encoded as a 32-bit channel descriptor:

| Value | Meaning |
|-------|---------|
| GREY1 | 1-bit greyscale |
| GREY8 | 8-bit greyscale |
| RGB24 | 8 bits each R, G, B |
| RGBA32 | 8 bits each R, G, B, A |
| ARGB32 | 8 bits each A, R, G, B |
| XRGB32 | x888 (alpha ignored) |

Plan 9 channel encoding packs depth and order into 32 bits. See `/sys/include/draw.h`.

## Image Table

```typescript
interface Image {
  id: number;
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  r: Rect;           // Bounds
  clipr: Rect;       // Clip rectangle
  repl: boolean;     // Replicate (tile)
  chan: number;      // Channel format
}

class ImageTable {
  private images = new Map<number, Image>();
  private screen: Image;        // The display
  private displayCanvas: HTMLCanvasElement;
  
  alloc(id: number, r: Rect, chan: number, repl: boolean): Image {
    const width = r.max.x - r.min.x;
    const height = r.max.y - r.min.y;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    
    const img: Image = { id, canvas, ctx, r, clipr: r, repl, chan };
    this.images.set(id, img);
    return img;
  }
  
  free(id: number): void {
    this.images.delete(id);
  }
  
  get(id: number): Image | undefined {
    return this.images.get(id);
  }
  
  flush(): void {
    // Copy screen image to display canvas
    const displayCtx = this.displayCanvas.getContext('2d')!;
    displayCtx.drawImage(this.screen.canvas, 0, 0);
  }
}
```

## Draw Command Interpreter

```typescript
class DrawInterpreter {
  private images: ImageTable;
  private compositeOp: GlobalCompositeOperation = 'source-over';
  
  execute(data: Uint8Array): void {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    
    while (offset < data.length) {
      const op = String.fromCharCode(data[offset++]);
      
      switch (op) {
        case 'A': // allocate
          offset = this.opAlloc(view, offset);
          break;
        case 'd': // draw
          offset = this.opDraw(view, offset);
          break;
        case 'e': // ellipse
          offset = this.opEllipse(view, offset);
          break;
        case 'f': // free
          offset = this.opFree(view, offset);
          break;
        case 'l': // line
          offset = this.opLine(view, offset);
          break;
        case 'L': // loadimage
          offset = this.opLoadImage(view, offset);
          break;
        case 'p': // poly
          offset = this.opPoly(view, offset);
          break;
        case 's': // string
          offset = this.opString(view, offset);
          break;
        case 'v': // flush
          this.images.flush();
          break;
        // ... more ops
      }
    }
  }
  
  private opDraw(view: DataView, offset: number): number {
    const dstid = view.getInt32(offset, true); offset += 4;
    const srcid = view.getInt32(offset, true); offset += 4;
    const maskid = view.getInt32(offset, true); offset += 4;
    const dstR = this.readRect(view, offset); offset += 16;
    const srcPt = this.readPoint(view, offset); offset += 8;
    const maskPt = this.readPoint(view, offset); offset += 8;
    
    const dst = this.images.get(dstid);
    const src = this.images.get(srcid);
    
    if (dst && src) {
      const width = dstR.max.x - dstR.min.x;
      const height = dstR.max.y - dstR.min.y;
      
      dst.ctx.drawImage(
        src.canvas,
        srcPt.x - src.r.min.x,
        srcPt.y - src.r.min.y,
        width, height,
        dstR.min.x - dst.r.min.x,
        dstR.min.y - dst.r.min.y,
        width, height
      );
    }
    
    return offset;
  }
  
  private opLine(view: DataView, offset: number): number {
    const dstid = view.getInt32(offset, true); offset += 4;
    const srcid = view.getInt32(offset, true); offset += 4;
    const p0 = this.readPoint(view, offset); offset += 8;
    const p1 = this.readPoint(view, offset); offset += 8;
    const end0 = view.getInt32(offset, true); offset += 4;
    const end1 = view.getInt32(offset, true); offset += 4;
    const thick = view.getInt32(offset, true); offset += 4;
    const sp = this.readPoint(view, offset); offset += 8;
    
    const dst = this.images.get(dstid);
    const src = this.images.get(srcid);
    
    if (dst && src) {
      dst.ctx.strokeStyle = this.getColor(src, sp);
      dst.ctx.lineWidth = thick;
      dst.ctx.lineCap = this.endCap(end0);
      
      dst.ctx.beginPath();
      dst.ctx.moveTo(p0.x - dst.r.min.x, p0.y - dst.r.min.y);
      dst.ctx.lineTo(p1.x - dst.r.min.x, p1.y - dst.r.min.y);
      dst.ctx.stroke();
    }
    
    return offset;
  }
  
  private readPoint(view: DataView, offset: number): Point {
    return {
      x: view.getInt32(offset, true),
      y: view.getInt32(offset + 4, true),
    };
  }
  
  private readRect(view: DataView, offset: number): Rect {
    return {
      min: this.readPoint(view, offset),
      max: this.readPoint(view, offset + 8),
    };
  }
}
```

## /dev/mouse

### Read Format

Reading /dev/mouse returns:

```
m x y buttons msec
```

As text, space-separated. Or in binary:
```
┌───┬─────────┬─────────┬──────────┬──────────┐
│ m │  x[4]   │  y[4]   │ btn[4]   │ msec[4]  │
│[1]│ (LE i32)│ (LE i32)│ (LE i32) │ (LE u32) │
└───┴─────────┴─────────┴──────────┴──────────┘
```

### Write Format

Writing to /dev/mouse moves the cursor.

### Button Encoding

| Bit | Button |
|-----|--------|
| 1 | Left |
| 2 | Middle |
| 4 | Right |
| 8 | Scroll up |
| 16 | Scroll down |

### Mouse Handler

```typescript
class MouseDevice {
  private canvas: HTMLCanvasElement;
  private fid: number;
  private buttons = 0;
  
  constructor(canvas: HTMLCanvasElement, client: Client9P, fid: number) {
    this.canvas = canvas;
    this.fid = fid;
    
    canvas.addEventListener('mousedown', (e) => this.onMouse(e));
    canvas.addEventListener('mouseup', (e) => this.onMouse(e));
    canvas.addEventListener('mousemove', (e) => this.onMouse(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  
  private onMouse(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Map browser buttons to Plan 9
    let buttons = 0;
    if (e.buttons & 1) buttons |= 1;  // Left
    if (e.buttons & 4) buttons |= 2;  // Middle
    if (e.buttons & 2) buttons |= 4;  // Right
    
    this.sendMouse(x, y, buttons);
  }
  
  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Scroll as button press
    const scrollButton = e.deltaY < 0 ? 8 : 16;
    
    // Press
    this.sendMouse(x, y, this.buttons | scrollButton);
    // Release after short delay
    setTimeout(() => {
      this.sendMouse(x, y, this.buttons);
    }, 50);
  }
  
  private sendMouse(x: number, y: number, buttons: number): void {
    this.buttons = buttons & 7;  // Store physical buttons
    
    const data = new Uint8Array(1 + 4 * 4);
    const view = new DataView(data.buffer);
    
    data[0] = 'm'.charCodeAt(0);
    view.setInt32(1, Math.round(x), true);
    view.setInt32(5, Math.round(y), true);
    view.setInt32(9, buttons, true);
    view.setUint32(13, Date.now() & 0xFFFFFFFF, true);
    
    this.client.write(this.fid, 0n, data);
  }
}
```

## Keyboard in Graphics Mode

In graphics mode, /dev/cons delivers runes (Unicode codepoints) not raw bytes:

```typescript
class GraphicsConsole {
  private fid: number;
  
  constructor(canvas: HTMLCanvasElement, client: Client9P, fid: number) {
    this.fid = fid;
    
    // Use keypress for printable characters
    window.addEventListener('keypress', (e) => {
      if (e.key.length === 1) {
        this.sendRune(e.key.codePointAt(0)!);
      }
    });
    
    // Use keydown for special keys
    window.addEventListener('keydown', (e) => {
      const rune = this.specialKey(e);
      if (rune !== null) {
        e.preventDefault();
        this.sendRune(rune);
      }
    });
  }
  
  private specialKey(e: KeyboardEvent): number | null {
    // Plan 9 keyboard constants (from /sys/include/keyboard.h)
    switch (e.key) {
      case 'Home':      return 0xF00D;
      case 'End':       return 0xF00E;
      case 'PageUp':    return 0xF00F;
      case 'PageDown':  return 0xF010;
      case 'ArrowUp':   return 0xF00E;
      case 'ArrowDown': return 0x80;
      case 'ArrowLeft': return 0xF011;
      case 'ArrowRight':return 0xF012;
      case 'Insert':    return 0xF006;
      case 'Delete':    return 0x7F;
      case 'Escape':    return 0x1B;
      case 'Backspace': return 0x08;
      case 'Tab':       return 0x09;
      case 'Enter':     return 0x0A;
      default:
        if (e.ctrlKey && e.key.length === 1) {
          return e.key.toUpperCase().charCodeAt(0) - 64;
        }
        return null;
    }
  }
  
  private sendRune(rune: number): void {
    // UTF-8 encode the rune
    const str = String.fromCodePoint(rune);
    const data = new TextEncoder().encode(str);
    this.client.write(this.fid, 0n, data);
  }
}
```

## Window Resize

Handle browser window resize:

```typescript
class DisplayManager {
  private canvas: HTMLCanvasElement;
  private screenId: number;
  
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    
    window.addEventListener('resize', () => this.onResize());
    this.onResize();  // Initial size
  }
  
  private onResize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    this.canvas.width = width;
    this.canvas.height = height;
    
    // Notify server of new size
    // This requires writing to /dev/draw/N/ctl
    // The server will reallocate the screen image
  }
}
```

## Fonts

Plan 9 has its own font format. Options:

1. **Convert at runtime**: Load Plan 9 subfonts, convert to Canvas font
2. **Use web fonts**: Map Plan 9 font requests to CSS fonts
3. **Render server-side**: Return rasterized glyphs

For MVP, option 2 with fallbacks:

```typescript
function mapFont(p9font: string): string {
  const map: Record<string, string> = {
    '/lib/font/bit/pelm/latin1.9.font': '12px "Go Mono", monospace',
    '/lib/font/bit/lucm/unicode.9.font': '12px "Go Mono", monospace',
    '/lib/font/bit/lucsans/typelatin1.7.font': '14px sans-serif',
    // Add more mappings
  };
  return map[p9font] ?? '12px monospace';
}
```

## Complete Device Setup

```typescript
async function setupGraphics(client: Client9P, canvas: HTMLCanvasElement): Promise<void> {
  // Open /dev/draw/new
  const newFid = await client.walkOpen(['dev', 'draw', 'new'], OREAD);
  const connData = await client.read(newFid, 0n, 128);
  const connId = parseConnId(connData);
  await client.clunk(newFid);
  
  // Open ctl and data
  const ctlFid = await client.walkOpen(['dev', 'draw', connId, 'ctl'], ORDWR);
  const dataFid = await client.walkOpen(['dev', 'draw', connId, 'data'], ORDWR);
  
  // Initialize screen
  const screenInfo = await client.read(ctlFid, 0n, 256);
  const screen = parseScreenInfo(screenInfo);
  
  // Create image table with screen
  const images = new ImageTable(canvas, screen);
  const interpreter = new DrawInterpreter(images);
  
  // Open mouse
  const mouseFid = await client.walkOpen(['dev', 'mouse'], ORDWR);
  new MouseDevice(canvas, client, mouseFid);
  
  // Open cons
  const consFid = await client.walkOpen(['dev', 'cons'], ORDWR);
  new GraphicsConsole(canvas, client, consFid);
  
  // Read loop for draw commands
  readLoop(client, dataFid, (data) => {
    interpreter.execute(data);
  });
}
```

## Deliverables

### TypeScript Files

| File | Purpose |
|------|---------|
| `devices/draw.ts` | Draw protocol interpreter |
| `devices/mouse.ts` | Mouse device handler |
| `devices/images.ts` | Image table management |
| `ui/canvas.ts` | Canvas setup and resize |

## Success Criteria

Phase 3 is complete when:

1. Screen image renders in canvas
2. Draw commands update the display
3. Mouse events are captured and sent
4. Keyboard events work in graphics mode
5. Window resize is handled
6. rio or acme runs usably
