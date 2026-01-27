# TypeScript Client Architecture

This document describes the TypeScript client structure, interfaces, and patterns.

## Module Overview

```
client/src/
├── transport.ts          # WebSocket management
├── 9p/
│   ├── types.ts          # Type definitions
│   ├── messages.ts       # Message encode/decode
│   ├── client.ts         # 9P client
│   └── fid.ts            # Fid pool
├── devices/
│   ├── cons.ts           # /dev/cons
│   ├── draw.ts           # /dev/draw interpreter
│   ├── mouse.ts          # /dev/mouse
│   └── images.ts         # Image table
├── auth/
│   ├── auth.ts           # WASM bindings
│   └── credentials.ts    # UI for credentials
├── ui/
│   ├── terminal.ts       # Text terminal
│   └── canvas.ts         # Graphics canvas
└── main.ts               # Entry point
```

## Type Definitions (types.ts)

```typescript
// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

export const NOTAG = 0xFFFF;
export const NOFID = 0xFFFFFFFF;
export const IOHDRSZ = 24;

// Message types
export const TVERSION = 100;
export const RVERSION = 101;
export const TAUTH = 102;
export const RAUTH = 103;
export const TATTACH = 104;
export const RATTACH = 105;
export const RERROR = 107;
export const TFLUSH = 108;
export const RFLUSH = 109;
export const TWALK = 110;
export const RWALK = 111;
export const TOPEN = 112;
export const ROPEN = 113;
export const TCREATE = 114;
export const RCREATE = 115;
export const TREAD = 116;
export const RREAD = 117;
export const TWRITE = 118;
export const RWRITE = 119;
export const TCLUNK = 120;
export const RCLUNK = 121;
export const TREMOVE = 122;
export const RREMOVE = 123;
export const TSTAT = 124;
export const RSTAT = 125;
export const TWSTAT = 126;
export const RWSTAT = 127;

// Open modes
export const OREAD = 0;
export const OWRITE = 1;
export const ORDWR = 2;
export const OEXEC = 3;
export const OTRUNC = 0x10;
export const ORCLOSE = 0x40;

// QID types
export const QTDIR = 0x80;
export const QTAPPEND = 0x40;
export const QTEXCL = 0x20;
export const QTAUTH = 0x08;
export const QTTMP = 0x04;
export const QTFILE = 0x00;

// ─────────────────────────────────────────────────────────────
// Structures
// ─────────────────────────────────────────────────────────────

export interface Qid {
  type: number;
  vers: number;
  path: bigint;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  min: Point;
  max: Point;
}

// ─────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────

export interface TMessage {
  type: number;
  tag: number;
}

export interface RMessage {
  type: number;
  tag: number;
}

export interface Tversion extends TMessage {
  type: typeof TVERSION;
  msize: number;
  version: string;
}

export interface Rversion extends RMessage {
  type: typeof RVERSION;
  msize: number;
  version: string;
}

export interface Tauth extends TMessage {
  type: typeof TAUTH;
  afid: number;
  uname: string;
  aname: string;
}

export interface Rauth extends RMessage {
  type: typeof RAUTH;
  aqid: Qid;
}

export interface Tattach extends TMessage {
  type: typeof TATTACH;
  fid: number;
  afid: number;
  uname: string;
  aname: string;
}

export interface Rattach extends RMessage {
  type: typeof RATTACH;
  qid: Qid;
}

export interface Rerror extends RMessage {
  type: typeof RERROR;
  ename: string;
}

export interface Twalk extends TMessage {
  type: typeof TWALK;
  fid: number;
  newfid: number;
  wnames: string[];
}

export interface Rwalk extends RMessage {
  type: typeof RWALK;
  qids: Qid[];
}

export interface Topen extends TMessage {
  type: typeof TOPEN;
  fid: number;
  mode: number;
}

export interface Ropen extends RMessage {
  type: typeof ROPEN;
  qid: Qid;
  iounit: number;
}

export interface Tread extends TMessage {
  type: typeof TREAD;
  fid: number;
  offset: bigint;
  count: number;
}

export interface Rread extends RMessage {
  type: typeof RREAD;
  data: Uint8Array;
}

export interface Twrite extends TMessage {
  type: typeof TWRITE;
  fid: number;
  offset: bigint;
  data: Uint8Array;
}

export interface Rwrite extends RMessage {
  type: typeof RWRITE;
  count: number;
}

export interface Tclunk extends TMessage {
  type: typeof TCLUNK;
  fid: number;
}

export interface Rclunk extends RMessage {
  type: typeof RCLUNK;
}

export type AnyTMessage = 
  | Tversion | Tauth | Tattach | Twalk 
  | Topen | Tread | Twrite | Tclunk;

export type AnyRMessage = 
  | Rversion | Rauth | Rattach | Rerror | Rwalk 
  | Ropen | Rread | Rwrite | Rclunk;
```

## Message Encoding (messages.ts)

```typescript
import * as T from './types';

// ─────────────────────────────────────────────────────────────
// Encoding
// ─────────────────────────────────────────────────────────────

export function encode(msg: T.AnyTMessage): Uint8Array {
  switch (msg.type) {
    case T.TVERSION: return encodeTversion(msg);
    case T.TAUTH:    return encodeTauth(msg);
    case T.TATTACH:  return encodeTattach(msg);
    case T.TWALK:    return encodeTwalk(msg);
    case T.TOPEN:    return encodeTopen(msg);
    case T.TREAD:    return encodeTread(msg);
    case T.TWRITE:   return encodeTwrite(msg);
    case T.TCLUNK:   return encodeTclunk(msg);
    default:
      throw new Error(`Unknown message type: ${(msg as any).type}`);
  }
}

function encodeTversion(msg: T.Tversion): Uint8Array {
  const version = encodeString(msg.version);
  const size = 4 + 1 + 2 + 4 + version.length;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  
  view.setUint32(0, size, true);
  view.setUint8(4, msg.type);
  view.setUint16(5, msg.tag, true);
  view.setUint32(7, msg.msize, true);
  buf.set(version, 11);
  
  return buf;
}

function encodeTattach(msg: T.Tattach): Uint8Array {
  const uname = encodeString(msg.uname);
  const aname = encodeString(msg.aname);
  const size = 4 + 1 + 2 + 4 + 4 + uname.length + aname.length;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  
  let offset = 0;
  view.setUint32(offset, size, true); offset += 4;
  view.setUint8(offset, msg.type); offset += 1;
  view.setUint16(offset, msg.tag, true); offset += 2;
  view.setUint32(offset, msg.fid, true); offset += 4;
  view.setUint32(offset, msg.afid, true); offset += 4;
  buf.set(uname, offset); offset += uname.length;
  buf.set(aname, offset);
  
  return buf;
}

function encodeTwalk(msg: T.Twalk): Uint8Array {
  const names = msg.wnames.map(encodeString);
  const namesLen = names.reduce((sum, n) => sum + n.length, 0);
  const size = 4 + 1 + 2 + 4 + 4 + 2 + namesLen;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  
  let offset = 0;
  view.setUint32(offset, size, true); offset += 4;
  view.setUint8(offset, msg.type); offset += 1;
  view.setUint16(offset, msg.tag, true); offset += 2;
  view.setUint32(offset, msg.fid, true); offset += 4;
  view.setUint32(offset, msg.newfid, true); offset += 4;
  view.setUint16(offset, msg.wnames.length, true); offset += 2;
  for (const name of names) {
    buf.set(name, offset);
    offset += name.length;
  }
  
  return buf;
}

function encodeTopen(msg: T.Topen): Uint8Array {
  const size = 4 + 1 + 2 + 4 + 1;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  
  view.setUint32(0, size, true);
  view.setUint8(4, msg.type);
  view.setUint16(5, msg.tag, true);
  view.setUint32(7, msg.fid, true);
  view.setUint8(11, msg.mode);
  
  return buf;
}

function encodeTread(msg: T.Tread): Uint8Array {
  const size = 4 + 1 + 2 + 4 + 8 + 4;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  
  view.setUint32(0, size, true);
  view.setUint8(4, msg.type);
  view.setUint16(5, msg.tag, true);
  view.setUint32(7, msg.fid, true);
  view.setBigUint64(11, msg.offset, true);
  view.setUint32(19, msg.count, true);
  
  return buf;
}

function encodeTwrite(msg: T.Twrite): Uint8Array {
  const size = 4 + 1 + 2 + 4 + 8 + 4 + msg.data.length;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  
  view.setUint32(0, size, true);
  view.setUint8(4, msg.type);
  view.setUint16(5, msg.tag, true);
  view.setUint32(7, msg.fid, true);
  view.setBigUint64(11, msg.offset, true);
  view.setUint32(19, msg.data.length, true);
  buf.set(msg.data, 23);
  
  return buf;
}

function encodeTclunk(msg: T.Tclunk): Uint8Array {
  const size = 4 + 1 + 2 + 4;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  
  view.setUint32(0, size, true);
  view.setUint8(4, msg.type);
  view.setUint16(5, msg.tag, true);
  view.setUint32(7, msg.fid, true);
  
  return buf;
}

function encodeString(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  const buf = new Uint8Array(2 + encoded.length);
  const view = new DataView(buf.buffer);
  view.setUint16(0, encoded.length, true);
  buf.set(encoded, 2);
  return buf;
}

// ─────────────────────────────────────────────────────────────
// Decoding
// ─────────────────────────────────────────────────────────────

export function decode(data: Uint8Array): T.AnyRMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  
  const size = view.getUint32(0, true);
  const type = view.getUint8(4);
  const tag = view.getUint16(5, true);
  
  switch (type) {
    case T.RVERSION: return decodeRversion(view, tag);
    case T.RAUTH:    return decodeRauth(view, tag);
    case T.RATTACH:  return decodeRattach(view, tag);
    case T.RERROR:   return decodeRerror(view, tag);
    case T.RWALK:    return decodeRwalk(view, tag);
    case T.ROPEN:    return decodeRopen(view, tag);
    case T.RREAD:    return decodeRread(view, tag, data);
    case T.RWRITE:   return decodeRwrite(view, tag);
    case T.RCLUNK:   return { type: T.RCLUNK, tag };
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

function decodeRversion(view: DataView, tag: number): T.Rversion {
  const msize = view.getUint32(7, true);
  const version = decodeString(view, 11);
  return { type: T.RVERSION, tag, msize, version };
}

function decodeRattach(view: DataView, tag: number): T.Rattach {
  const qid = decodeQid(view, 7);
  return { type: T.RATTACH, tag, qid };
}

function decodeRerror(view: DataView, tag: number): T.Rerror {
  const ename = decodeString(view, 7);
  return { type: T.RERROR, tag, ename };
}

function decodeRwalk(view: DataView, tag: number): T.Rwalk {
  const nqid = view.getUint16(7, true);
  const qids: T.Qid[] = [];
  let offset = 9;
  for (let i = 0; i < nqid; i++) {
    qids.push(decodeQid(view, offset));
    offset += 13;
  }
  return { type: T.RWALK, tag, qids };
}

function decodeRopen(view: DataView, tag: number): T.Ropen {
  const qid = decodeQid(view, 7);
  const iounit = view.getUint32(20, true);
  return { type: T.ROPEN, tag, qid, iounit };
}

function decodeRread(view: DataView, tag: number, raw: Uint8Array): T.Rread {
  const count = view.getUint32(7, true);
  const data = raw.slice(11, 11 + count);
  return { type: T.RREAD, tag, data };
}

function decodeRwrite(view: DataView, tag: number): T.Rwrite {
  const count = view.getUint32(7, true);
  return { type: T.RWRITE, tag, count };
}

function decodeQid(view: DataView, offset: number): T.Qid {
  return {
    type: view.getUint8(offset),
    vers: view.getUint32(offset + 1, true),
    path: view.getBigUint64(offset + 5, true),
  };
}

function decodeString(view: DataView, offset: number): string {
  const len = view.getUint16(offset, true);
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset + 2, len);
  return new TextDecoder().decode(bytes);
}
```

## 9P Client (client.ts)

```typescript
import { Transport } from '../transport';
import { encode, decode } from './messages';
import * as T from './types';
import { FidPool } from './fid';

export type ResponseCallback = (msg: T.AnyRMessage) => void;

export class Client9P {
  private transport: Transport;
  private fidPool = new FidPool();
  private tagCounter = 0;
  private pending = new Map<number, ResponseCallback>();
  private msize = 8192;
  
  constructor(transport: Transport) {
    this.transport = transport;
    this.transport.onMessage = (data) => this.handleMessage(data);
  }
  
  private allocTag(): number {
    const tag = this.tagCounter++;
    if (this.tagCounter >= T.NOTAG) this.tagCounter = 0;
    return tag;
  }
  
  private send(msg: T.AnyTMessage, callback: ResponseCallback): void {
    this.pending.set(msg.tag, callback);
    this.transport.send(encode(msg));
  }
  
  private handleMessage(data: Uint8Array): void {
    const msg = decode(data);
    const callback = this.pending.get(msg.tag);
    if (callback) {
      this.pending.delete(msg.tag);
      callback(msg);
    }
  }
  
  // ─────────────────────────────────────────────────────────
  // High-level API (Promise-based)
  // ─────────────────────────────────────────────────────────
  
  version(msize: number = 8192): Promise<T.Rversion> {
    return new Promise((resolve, reject) => {
      const msg: T.Tversion = {
        type: T.TVERSION,
        tag: T.NOTAG,
        msize,
        version: '9P2000',
      };
      this.send(msg, (r) => {
        if (r.type === T.RERROR) {
          reject(new Error((r as T.Rerror).ename));
        } else {
          this.msize = (r as T.Rversion).msize;
          resolve(r as T.Rversion);
        }
      });
    });
  }
  
  attach(fid: number, afid: number, uname: string, aname: string): Promise<T.Rattach> {
    return new Promise((resolve, reject) => {
      const msg: T.Tattach = {
        type: T.TATTACH,
        tag: this.allocTag(),
        fid,
        afid,
        uname,
        aname,
      };
      this.send(msg, (r) => {
        if (r.type === T.RERROR) {
          reject(new Error((r as T.Rerror).ename));
        } else {
          resolve(r as T.Rattach);
        }
      });
    });
  }
  
  walk(fid: number, newfid: number, wnames: string[]): Promise<T.Rwalk> {
    return new Promise((resolve, reject) => {
      const msg: T.Twalk = {
        type: T.TWALK,
        tag: this.allocTag(),
        fid,
        newfid,
        wnames,
      };
      this.send(msg, (r) => {
        if (r.type === T.RERROR) {
          reject(new Error((r as T.Rerror).ename));
        } else {
          resolve(r as T.Rwalk);
        }
      });
    });
  }
  
  open(fid: number, mode: number): Promise<T.Ropen> {
    return new Promise((resolve, reject) => {
      const msg: T.Topen = {
        type: T.TOPEN,
        tag: this.allocTag(),
        fid,
        mode,
      };
      this.send(msg, (r) => {
        if (r.type === T.RERROR) {
          reject(new Error((r as T.Rerror).ename));
        } else {
          resolve(r as T.Ropen);
        }
      });
    });
  }
  
  read(fid: number, offset: bigint, count: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const msg: T.Tread = {
        type: T.TREAD,
        tag: this.allocTag(),
        fid,
        offset,
        count: Math.min(count, this.msize - T.IOHDRSZ),
      };
      this.send(msg, (r) => {
        if (r.type === T.RERROR) {
          reject(new Error((r as T.Rerror).ename));
        } else {
          resolve((r as T.Rread).data);
        }
      });
    });
  }
  
  write(fid: number, offset: bigint, data: Uint8Array): Promise<number> {
    return new Promise((resolve, reject) => {
      const msg: T.Twrite = {
        type: T.TWRITE,
        tag: this.allocTag(),
        fid,
        offset,
        data: data.slice(0, this.msize - T.IOHDRSZ),
      };
      this.send(msg, (r) => {
        if (r.type === T.RERROR) {
          reject(new Error((r as T.Rerror).ename));
        } else {
          resolve((r as T.Rwrite).count);
        }
      });
    });
  }
  
  clunk(fid: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const msg: T.Tclunk = {
        type: T.TCLUNK,
        tag: this.allocTag(),
        fid,
      };
      this.send(msg, (r) => {
        if (r.type === T.RERROR) {
          reject(new Error((r as T.Rerror).ename));
        } else {
          this.fidPool.release(fid);
          resolve();
        }
      });
    });
  }
  
  // ─────────────────────────────────────────────────────────
  // Convenience methods
  // ─────────────────────────────────────────────────────────
  
  allocFid(): number {
    return this.fidPool.alloc();
  }
  
  async walkOpen(path: string[], mode: number): Promise<number> {
    const fid = this.allocFid();
    await this.walk(0, fid, path);
    await this.open(fid, mode);
    return fid;
  }
}
```

## Transport (transport.ts)

```typescript
export interface TransportOptions {
  url: string;  // e.g., 'wss://9front.local:8080/cpu'
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
  reconnect?: boolean;
  reconnectDelay?: number;
}

export class Transport {
  private ws: WebSocket | null = null;
  private options: TransportOptions;
  private reconnectTimer: number | null = null;
  
  onMessage: ((data: Uint8Array) => void) | null = null;
  
  constructor(options: TransportOptions) {
    this.options = {
      reconnect: true,
      reconnectDelay: 1000,
      ...options,
    };
  }
  
  connect(): void {
    this.ws = new WebSocket(this.options.url);
    this.ws.binaryType = 'arraybuffer';
    
    this.ws.onopen = () => {
      this.options.onConnect?.();
    };
    
    this.ws.onclose = (event) => {
      this.options.onDisconnect?.(event.reason || 'Connection closed');
      if (this.options.reconnect) {
        this.scheduleReconnect();
      }
    };
    
    this.ws.onerror = () => {
      this.options.onError?.(new Error('WebSocket error'));
    };
    
    this.ws.onmessage = (event) => {
      const data = new Uint8Array(event.data);
      this.onMessage?.(data);
    };
  }
  
  disconnect(): void {
    this.options.reconnect = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
    }
    this.ws?.close();
    this.ws = null;
  }
  
  send(data: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      throw new Error('WebSocket not connected');
    }
  }
  
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
  
  private scheduleReconnect(): void {
    this.reconnectTimer = window.setTimeout(() => {
      this.connect();
    }, this.options.reconnectDelay);
  }
}
```

## Build Configuration

### package.json

```json
{
  "name": "enoch-client",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "serve": "npx serve ."
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "sourceMap": true,
    "lib": ["ES2020", "DOM"]
  },
  "include": ["src/**/*"]
}
```

### index.html

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Enoch</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; overflow: hidden; }
    #terminal {
      width: 100vw;
      height: 100vh;
      font-family: monospace;
      font-size: 14px;
      color: #fff;
      padding: 8px;
      overflow-y: auto;
    }
    #canvas {
      width: 100vw;
      height: 100vh;
      display: none;
    }
  </style>
</head>
<body>
  <pre id="terminal"></pre>
  <canvas id="canvas"></canvas>
  <script type="module" src="dist/main.js"></script>
</body>
</html>
```
