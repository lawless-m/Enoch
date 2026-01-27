// Draw protocol types and constants
// Based on Plan 9's /dev/draw protocol

// Draw command opcodes (single-character prefixes)
export const enum DrawCmd {
  // Image management
  Alloc = 0x62,      // 'b' - Allocate image
  Free = 0x66,       // 'f' - Free image

  // Screen/layer management
  AllocScreen = 0x41, // 'A' - Allocate screen
  FreeScreen = 0x46,  // 'F' - Free screen
  PublicScreen = 0x53, // 'S' - Make screen public

  // Drawing operations
  Draw = 0x64,       // 'd' - Main draw operation (blit)
  Line = 0x4C,       // 'L' - Draw line
  Ellipse = 0x65,    // 'e' - Draw ellipse outline
  EllipseFill = 0x45, // 'E' - Draw filled ellipse
  Arc = 0x61,        // 'a' - Draw arc
  Poly = 0x70,       // 'p' - Draw polygon outline
  FillPoly = 0x50,   // 'P' - Fill polygon

  // Text
  String = 0x73,     // 's' - Draw string
  StringBg = 0x78,   // 'x' - Draw string with background

  // Pixel data
  Load = 0x79,       // 'y' - Load pixel data into image
  LoadCompressed = 0x59, // 'Y' - Load compressed pixel data
  Unload = 0x72,     // 'r' - Read pixel data from image

  // Window operations
  Origin = 0x6F,     // 'o' - Set origin
  SetClip = 0x63,    // 'c' - Set repl and clip rect
  SetOp = 0x4F,      // 'O' - Set compositing operator

  // Flush
  Flush = 0x76,      // 'v' - Flush

  // Naming
  NameImage = 0x4E,  // 'N' - Name an image (global)
  NameImageLocal = 0x6E, // 'n' - Name an image (local)

  // Font operations
  InitFont = 0x69,   // 'i' - Initialize font on image
  LoadChar = 0x6C,   // 'l' - Load character into font

  // Top/Bottom window
  Top = 0x74,        // 't' - Top layers
  Bottom = 0x42,     // 'B' - Bottom layers

  // Initialization
  Init = 0x49,       // 'I' - Initialize

  // Error
  Error = 0x21,      // '!' - Error (response only)
}

// Porter-Duff compositing operators
export const enum DrawOp {
  Clear = 0,
  SinD = 8,       // S in D
  DinS = 4,       // D in S
  SoutD = 2,      // S out D
  DoutS = 1,      // D out S
  S = 10,         // S (copy source)
  SoverD = 11,    // S over D (default)
  SatopD = 9,     // S atop D
  SxorD = 3,      // S xor D
  D = 5,          // D (keep dest)
  DoverS = 7,     // D over S
  DatopS = 6,     // D atop S
}

// Line end styles
export const enum EndStyle {
  EndSquare = 0,
  EndDisc = 1,
  EndArrow = 2,
  EndMask = 0x1F,
}

// Channel format constants (pixel format descriptors)
export const Channel = {
  // Common channel types
  CRed: 0,
  CGreen: 1,
  CBlue: 2,
  CGrey: 3,
  CAlpha: 4,
  CMap: 5,
  CIgnore: 6,

  // Common formats (32-bit hex encoding: type<<20 | bits<<12 | ...)
  GREY1: 0x00000031,    // 1-bit greyscale
  GREY2: 0x00000032,    // 2-bit greyscale
  GREY4: 0x00000034,    // 4-bit greyscale
  GREY8: 0x00000038,    // 8-bit greyscale
  CMAP8: 0x00000058,    // 8-bit colormap
  RGB15: 0x0050F005,    // 15-bit RGB (5-5-5)
  RGB16: 0x0053F006,    // 16-bit RGB (5-6-5)
  RGB24: 0x00888888,    // 24-bit RGB
  RGBA32: 0x88888888,   // 32-bit RGBA
  ARGB32: 0x88888880,   // 32-bit ARGB
  XRGB32: 0x68888888,   // 32-bit XRGB (ignore alpha)
  BGR24: 0x00008888,    // 24-bit BGR
  ABGR32: 0x08888888,   // 32-bit ABGR
  XBGR32: 0x06888888,   // 32-bit XBGR
};

// Point (2D coordinate)
export interface Point {
  x: number;
  y: number;
}

// Rectangle (min/max corners)
export interface Rectangle {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Image info returned from /dev/draw/new and /dev/draw/n/ctl
export interface ImageInfo {
  clientId: number;
  imageId: number;
  chan: string;      // Channel format string (e.g., "x8r8g8b8")
  repl: boolean;     // Replication flag
  r: Rectangle;      // Image rectangle
  clipr: Rectangle;  // Clipping rectangle
}

// Client-side image tracking
export interface ClientImage {
  id: number;
  width: number;
  height: number;
  chan: number;        // Channel format
  repl: boolean;       // Replication flag
  r: Rectangle;        // Image rectangle
  clipr: Rectangle;    // Clipping rectangle
  screenId: number;    // Screen ID (0 for standalone)
  data?: ImageData;    // Canvas pixel data (for standalone images)
  canvas?: OffscreenCanvas; // Canvas for rendering
}

// Client-side screen tracking
export interface ClientScreen {
  id: number;
  imageId: number;     // Backing image
  fillId: number;      // Fill pattern image
  isPublic: boolean;
}

// Font character metrics (matches Plan 9's Fontchar)
// Binary format: x[2] top[1] bottom[1] left[1] width[1] = 6 bytes
export interface FontChar {
  x: number;           // X position in subfont image (16-bit)
  top: number;         // Top of glyph relative to baseline (0-255)
  bottom: number;      // Bottom of glyph relative to baseline (0-255)
  left: number;        // Left bearing - offset to start drawing (signed, -128 to 127)
  width: number;       // Character advance width (0-255)
}

// Font info for a subfont
export interface FontInfo {
  id: number;          // Font image ID
  n: number;           // Number of characters
  ascent: number;      // Pixels above baseline
  height: number;      // Total height (computed from max bottom)
  chars: FontChar[];   // Character metrics (n+1 entries, last is sentinel)
}

// Parse a Fontchar from binary data (6 bytes)
export function parseFontchar(data: Uint8Array, offset: number): FontChar {
  const x = data[offset] | (data[offset + 1] << 8);
  const top = data[offset + 2];
  const bottom = data[offset + 3];
  // Left is signed
  let left = data[offset + 4];
  if (left > 127) left -= 256;
  const width = data[offset + 5];
  return { x, top, bottom, left, width };
}

// Encode a Fontchar to binary data (6 bytes)
export function encodeFontchar(fc: FontChar): Uint8Array {
  const data = new Uint8Array(6);
  data[0] = fc.x & 0xFF;
  data[1] = (fc.x >> 8) & 0xFF;
  data[2] = fc.top & 0xFF;
  data[3] = fc.bottom & 0xFF;
  data[4] = fc.left & 0xFF;  // signed to unsigned
  data[5] = fc.width & 0xFF;
  return data;
}

// Subfont header parsed from binary data
// Binary format: n[2] height[1] ascent[1] info[(n+1)*6]
export interface SubfontHeader {
  n: number;           // Number of characters
  height: number;      // Character height
  ascent: number;      // Pixels above baseline
  chars: FontChar[];   // Character metrics (n+1 entries)
  dataOffset: number;  // Offset where image data starts
}

// Parse a subfont header from binary data
// Returns the header and offset to the image data
export function parseSubfontHeader(data: Uint8Array): SubfontHeader | null {
  if (data.length < 4) return null;

  const n = data[0] | (data[1] << 8);
  const height = data[2];
  const ascent = data[3];

  const infoSize = (n + 1) * 6;
  if (data.length < 4 + infoSize) return null;

  const chars: FontChar[] = [];
  for (let i = 0; i <= n; i++) {
    chars.push(parseFontchar(data, 4 + i * 6));
  }

  return {
    n,
    height,
    ascent,
    chars,
    dataOffset: 4 + infoSize,
  };
}

// Font file entry (from .font file)
// Format: min max subfontpath
export interface FontRange {
  min: number;         // First character in range
  max: number;         // Last character in range
  path: string;        // Path to subfont file
  offset: number;      // Offset within subfont (usually 0)
}

// Parse a Plan 9 .font file
// Format:
//   height ascent
//   0x0000 0x00ff /lib/font/bit/pelm/latin1.9
//   0x0100 0x017f /lib/font/bit/pelm/latineur.9
//   ...
export function parseFontFile(text: string): { height: number; ascent: number; ranges: FontRange[] } | null {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 1) return null;

  // First line: height ascent
  const headerMatch = lines[0].match(/^\s*(\d+)\s+(\d+)/);
  if (!headerMatch) return null;

  const height = parseInt(headerMatch[1], 10);
  const ascent = parseInt(headerMatch[2], 10);
  const ranges: FontRange[] = [];

  // Remaining lines: min max path [offset]
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    // Format: 0x0000 0x00ff /path/to/subfont [offset]
    const match = line.match(/^(0x[0-9a-fA-F]+|\d+)\s+(0x[0-9a-fA-F]+|\d+)\s+(\S+)(?:\s+(\d+))?/);
    if (match) {
      const min = parseInt(match[1], match[1].startsWith('0x') ? 16 : 10);
      const max = parseInt(match[2], match[2].startsWith('0x') ? 16 : 10);
      const path = match[3];
      const offset = match[4] ? parseInt(match[4], 10) : 0;
      ranges.push({ min, max, path, offset });
    }
  }

  return { height, ascent, ranges };
}

// Helper functions
export function rectWidth(r: Rectangle): number {
  return r.maxX - r.minX;
}

export function rectHeight(r: Rectangle): number {
  return r.maxY - r.minY;
}

export function rectIntersect(a: Rectangle, b: Rectangle): Rectangle {
  return {
    minX: Math.max(a.minX, b.minX),
    minY: Math.max(a.minY, b.minY),
    maxX: Math.min(a.maxX, b.maxX),
    maxY: Math.min(a.maxY, b.maxY),
  };
}

export function rectIsEmpty(r: Rectangle): boolean {
  return r.minX >= r.maxX || r.minY >= r.maxY;
}

export function pointAdd(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function pointSub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

// Parse channel format string to number
export function parseChannel(s: string): number {
  // Simple parser for common formats
  const formats: Record<string, number> = {
    'k1': Channel.GREY1,
    'k2': Channel.GREY2,
    'k4': Channel.GREY4,
    'k8': Channel.GREY8,
    'm8': Channel.CMAP8,
    'r5g5b5': Channel.RGB15,
    'r5g6b5': Channel.RGB16,
    'r8g8b8': Channel.RGB24,
    'r8g8b8a8': Channel.RGBA32,
    'a8r8g8b8': Channel.ARGB32,
    'x8r8g8b8': Channel.XRGB32,
    'b8g8r8': Channel.BGR24,
    'a8b8g8r8': Channel.ABGR32,
    'x8b8g8r8': Channel.XBGR32,
  };
  return formats[s.toLowerCase()] ?? Channel.XRGB32;
}

// Format channel number to string
export function formatChannel(chan: number): string {
  const formats: Record<number, string> = {
    [Channel.GREY1]: 'k1',
    [Channel.GREY2]: 'k2',
    [Channel.GREY4]: 'k4',
    [Channel.GREY8]: 'k8',
    [Channel.CMAP8]: 'm8',
    [Channel.RGB15]: 'r5g5b5',
    [Channel.RGB16]: 'r5g6b5',
    [Channel.RGB24]: 'r8g8b8',
    [Channel.RGBA32]: 'r8g8b8a8',
    [Channel.ARGB32]: 'a8r8g8b8',
    [Channel.XRGB32]: 'x8r8g8b8',
    [Channel.BGR24]: 'b8g8r8',
    [Channel.ABGR32]: 'a8b8g8r8',
    [Channel.XBGR32]: 'x8b8g8r8',
  };
  return formats[chan] ?? 'x8r8g8b8';
}

// Get bits per pixel for a channel format
export function channelDepth(chan: number): number {
  // Extract depth from channel format
  // Common cases
  switch (chan) {
    case Channel.GREY1: return 1;
    case Channel.GREY2: return 2;
    case Channel.GREY4: return 4;
    case Channel.GREY8:
    case Channel.CMAP8: return 8;
    case Channel.RGB15: return 15;
    case Channel.RGB16: return 16;
    case Channel.RGB24:
    case Channel.BGR24: return 24;
    case Channel.RGBA32:
    case Channel.ARGB32:
    case Channel.XRGB32:
    case Channel.ABGR32:
    case Channel.XBGR32: return 32;
    default: return 32;
  }
}
