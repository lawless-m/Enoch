// 9P2000 server that provides /dev/cons and /dev/consctl
// Browser connects to cpu server, but serves these files back for terminal I/O

// 9P message types
const TVERSION = 100, RVERSION = 101;
const TATTACH = 104, RATTACH = 105;
const RERROR = 107;
const TWALK = 110, RWALK = 111;
const TOPEN = 112, ROPEN = 113;
const TREAD = 116, RREAD = 117;
const TWRITE = 118, RWRITE = 119;
const TCLUNK = 120, RCLUNK = 121;
const TSTAT = 124, RSTAT = 125;

// QID types
const QTDIR = 0x80;
const QTFILE = 0x00;

// Open modes
const OREAD = 0;
const OWRITE = 1;
const ORDWR = 2;

// File tree - static qid paths
const QID_ROOT = 0n;
const QID_DEV = 1n;
const QID_CONS = 2n;
const QID_CONSCTL = 3n;

interface Qid {
  type: number;
  vers: number;
  path: bigint;
}

interface FidState {
  qid: Qid;
  open: boolean;
  mode: number;
  offset: bigint;
}

interface ConsServerOptions {
  onWrite: (data: Uint8Array) => void;  // Called when server writes to cons
  onCtl?: (cmd: string) => void;         // Called when server writes to consctl
  msize?: number;
}

export class ConsServer {
  private msize: number = 8192;
  private fids: Map<number, FidState> = new Map();
  private inputBuffer: Uint8Array[] = [];
  private inputWaiting: ((data: Uint8Array) => void) | null = null;
  private onWrite: (data: Uint8Array) => void;
  private onCtl: (cmd: string) => void;

  constructor(opts: ConsServerOptions) {
    this.onWrite = opts.onWrite;
    this.onCtl = opts.onCtl || (() => {});
    if (opts.msize) this.msize = opts.msize;
  }

  // Queue keyboard input from terminal
  pushInput(data: Uint8Array): void {
    if (this.inputWaiting) {
      const cb = this.inputWaiting;
      this.inputWaiting = null;
      cb(data);
    } else {
      this.inputBuffer.push(data);
    }
  }

  // Process incoming 9P message, return response
  handleMessage(msg: Uint8Array): Uint8Array | null {
    if (msg.length < 7) return null;

    const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    const size = view.getUint32(0, true);
    const type = view.getUint8(4);
    const tag = view.getUint16(5, true);

    switch (type) {
      case TVERSION: return this.handleVersion(msg, tag);
      case TATTACH: return this.handleAttach(msg, tag);
      case TWALK: return this.handleWalk(msg, tag);
      case TOPEN: return this.handleOpen(msg, tag);
      case TREAD: return this.handleRead(msg, tag);
      case TWRITE: return this.handleWrite(msg, tag);
      case TCLUNK: return this.handleClunk(msg, tag);
      case TSTAT: return this.handleStat(msg, tag);
      default:
        console.warn(`Unknown 9P message type: ${type}`);
        return this.encodeError(tag, `unknown message type ${type}`);
    }
  }

  private handleVersion(msg: Uint8Array, tag: number): Uint8Array {
    const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    const clientMsize = view.getUint32(7, true);
    const vlen = view.getUint16(11, true);
    const version = new TextDecoder().decode(msg.subarray(13, 13 + vlen));

    // Negotiate msize and version
    this.msize = Math.min(clientMsize, this.msize);
    const respVersion = version.startsWith('9P2000') ? '9P2000' : 'unknown';

    // Reset state on version
    this.fids.clear();

    return this.encodeRversion(tag, this.msize, respVersion);
  }

  private handleAttach(msg: Uint8Array, tag: number): Uint8Array {
    const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    const fid = view.getUint32(7, true);
    // afid at 11, uname/aname follow - we ignore auth

    const qid: Qid = { type: QTDIR, vers: 0, path: QID_ROOT };
    this.fids.set(fid, { qid, open: false, mode: 0, offset: 0n });

    return this.encodeRattach(tag, qid);
  }

  private handleWalk(msg: Uint8Array, tag: number): Uint8Array {
    const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    const fid = view.getUint32(7, true);
    const newfid = view.getUint32(11, true);
    const nwname = view.getUint16(15, true);

    const state = this.fids.get(fid);
    if (!state) {
      return this.encodeError(tag, 'bad fid');
    }

    // Parse walk names
    const names: string[] = [];
    let off = 17;
    for (let i = 0; i < nwname; i++) {
      const len = view.getUint16(off, true);
      off += 2;
      names.push(new TextDecoder().decode(msg.subarray(off, off + len)));
      off += len;
    }

    // Walk the path
    let currentQid = state.qid;
    const qids: Qid[] = [];

    for (const name of names) {
      const next = this.walkOne(currentQid, name);
      if (!next) {
        if (qids.length === 0) {
          return this.encodeError(tag, `${name} not found`);
        }
        break; // Partial walk
      }
      qids.push(next);
      currentQid = next;
    }

    // Clone or walk
    if (nwname === 0) {
      // Clone fid
      this.fids.set(newfid, { ...state, open: false, offset: 0n });
    } else if (qids.length === nwname) {
      // Full walk succeeded
      this.fids.set(newfid, { qid: currentQid, open: false, mode: 0, offset: 0n });
    }

    return this.encodeRwalk(tag, qids);
  }

  private walkOne(from: Qid, name: string): Qid | null {
    if (from.path === QID_ROOT) {
      if (name === 'dev') return { type: QTDIR, vers: 0, path: QID_DEV };
    } else if (from.path === QID_DEV) {
      if (name === 'cons') return { type: QTFILE, vers: 0, path: QID_CONS };
      if (name === 'consctl') return { type: QTFILE, vers: 0, path: QID_CONSCTL };
    }
    return null;
  }

  private handleOpen(msg: Uint8Array, tag: number): Uint8Array {
    const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    const fid = view.getUint32(7, true);
    const mode = view.getUint8(11);

    const state = this.fids.get(fid);
    if (!state) {
      return this.encodeError(tag, 'bad fid');
    }
    if (state.open) {
      return this.encodeError(tag, 'already open');
    }

    state.open = true;
    state.mode = mode;
    state.offset = 0n;

    // iounit 0 = use msize
    return this.encodeRopen(tag, state.qid, 0);
  }

  private handleRead(msg: Uint8Array, tag: number): Uint8Array {
    const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    const fid = view.getUint32(7, true);
    const offset = view.getBigUint64(11, true);
    const count = view.getUint32(19, true);

    const state = this.fids.get(fid);
    if (!state) {
      return this.encodeError(tag, 'bad fid');
    }
    if (!state.open) {
      return this.encodeError(tag, 'not open');
    }

    // Handle reads based on file
    if (state.qid.path === QID_CONS) {
      // Read from keyboard buffer
      if (this.inputBuffer.length > 0) {
        const data = this.inputBuffer.shift()!;
        const chunk = data.slice(0, count);
        return this.encodeRread(tag, chunk);
      }
      // No input available - return empty (non-blocking for now)
      return this.encodeRread(tag, new Uint8Array(0));
    } else if (state.qid.path === QID_CONSCTL) {
      // consctl reads return empty
      return this.encodeRread(tag, new Uint8Array(0));
    } else if (state.qid.type & QTDIR) {
      // Directory read - return dir entries
      const entries = this.readDir(state.qid.path, offset, count);
      return this.encodeRread(tag, entries);
    }

    return this.encodeError(tag, 'cannot read');
  }

  private handleWrite(msg: Uint8Array, tag: number): Uint8Array {
    const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    const fid = view.getUint32(7, true);
    const offset = view.getBigUint64(11, true);
    const count = view.getUint32(19, true);
    const data = msg.subarray(23, 23 + count);

    const state = this.fids.get(fid);
    if (!state) {
      return this.encodeError(tag, 'bad fid');
    }
    if (!state.open) {
      return this.encodeError(tag, 'not open');
    }

    if (state.qid.path === QID_CONS) {
      // Write to terminal display
      this.onWrite(new Uint8Array(data));
      return this.encodeRwrite(tag, count);
    } else if (state.qid.path === QID_CONSCTL) {
      // Control command
      const cmd = new TextDecoder().decode(data).trim();
      this.onCtl(cmd);
      return this.encodeRwrite(tag, count);
    }

    return this.encodeError(tag, 'cannot write');
  }

  private handleClunk(msg: Uint8Array, tag: number): Uint8Array {
    const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    const fid = view.getUint32(7, true);

    this.fids.delete(fid);
    return this.encodeRclunk(tag);
  }

  private handleStat(msg: Uint8Array, tag: number): Uint8Array {
    const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    const fid = view.getUint32(7, true);

    const state = this.fids.get(fid);
    if (!state) {
      return this.encodeError(tag, 'bad fid');
    }

    return this.encodeRstat(tag, state.qid);
  }

  private readDir(path: bigint, offset: bigint, count: number): Uint8Array {
    // Get entries for this directory
    let entries: { name: string; qid: Qid }[] = [];

    if (path === QID_ROOT) {
      entries = [{ name: 'dev', qid: { type: QTDIR, vers: 0, path: QID_DEV } }];
    } else if (path === QID_DEV) {
      entries = [
        { name: 'cons', qid: { type: QTFILE, vers: 0, path: QID_CONS } },
        { name: 'consctl', qid: { type: QTFILE, vers: 0, path: QID_CONSCTL } },
      ];
    }

    // Encode as stat entries
    const statBufs: Uint8Array[] = entries.map(e => this.encodeStat(e.name, e.qid));
    const total = statBufs.reduce((sum, b) => sum + b.length, 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const buf of statBufs) {
      all.set(buf, off);
      off += buf.length;
    }

    // Apply offset and count
    const start = Number(offset);
    if (start >= all.length) return new Uint8Array(0);
    return all.subarray(start, Math.min(start + count, all.length));
  }

  private encodeStat(name: string, qid: Qid): Uint8Array {
    const nameBytes = new TextEncoder().encode(name);
    const uid = new TextEncoder().encode('none');
    const gid = new TextEncoder().encode('none');
    const muid = new TextEncoder().encode('none');

    // stat structure size (excluding 2-byte size prefix)
    const statSize = 2 + 4 + 13 + 4 + 4 + 4 + 8 +
                     (2 + nameBytes.length) + (2 + uid.length) +
                     (2 + gid.length) + (2 + muid.length);

    const buf = new Uint8Array(2 + statSize);
    const view = new DataView(buf.buffer);
    let off = 0;

    // size[2]
    view.setUint16(off, statSize, true); off += 2;
    // type[2] - kernel type, 0 for user files
    view.setUint16(off, 0, true); off += 2;
    // dev[4]
    view.setUint32(off, 0, true); off += 4;
    // qid[13]
    view.setUint8(off, qid.type); off += 1;
    view.setUint32(off, qid.vers, true); off += 4;
    view.setBigUint64(off, qid.path, true); off += 8;
    // mode[4]
    const mode = (qid.type & QTDIR) ? 0x80000000 | 0o755 : 0o644;
    view.setUint32(off, mode, true); off += 4;
    // atime[4], mtime[4]
    view.setUint32(off, 0, true); off += 4;
    view.setUint32(off, 0, true); off += 4;
    // length[8]
    view.setBigUint64(off, 0n, true); off += 8;
    // name[s]
    view.setUint16(off, nameBytes.length, true); off += 2;
    buf.set(nameBytes, off); off += nameBytes.length;
    // uid[s]
    view.setUint16(off, uid.length, true); off += 2;
    buf.set(uid, off); off += uid.length;
    // gid[s]
    view.setUint16(off, gid.length, true); off += 2;
    buf.set(gid, off); off += gid.length;
    // muid[s]
    view.setUint16(off, muid.length, true); off += 2;
    buf.set(muid, off);

    return buf;
  }

  // Encode response messages

  private encodeRversion(tag: number, msize: number, version: string): Uint8Array {
    const versionBytes = new TextEncoder().encode(version);
    const size = 4 + 1 + 2 + 4 + 2 + versionBytes.length;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    view.setUint32(0, size, true);
    view.setUint8(4, RVERSION);
    view.setUint16(5, tag, true);
    view.setUint32(7, msize, true);
    view.setUint16(11, versionBytes.length, true);
    buf.set(versionBytes, 13);
    return buf;
  }

  private encodeRattach(tag: number, qid: Qid): Uint8Array {
    const size = 4 + 1 + 2 + 13;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    view.setUint32(0, size, true);
    view.setUint8(4, RATTACH);
    view.setUint16(5, tag, true);
    this.encodeQid(view, 7, qid);
    return buf;
  }

  private encodeRwalk(tag: number, qids: Qid[]): Uint8Array {
    const size = 4 + 1 + 2 + 2 + qids.length * 13;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    view.setUint32(0, size, true);
    view.setUint8(4, RWALK);
    view.setUint16(5, tag, true);
    view.setUint16(7, qids.length, true);
    let off = 9;
    for (const qid of qids) {
      this.encodeQid(view, off, qid);
      off += 13;
    }
    return buf;
  }

  private encodeRopen(tag: number, qid: Qid, iounit: number): Uint8Array {
    const size = 4 + 1 + 2 + 13 + 4;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    view.setUint32(0, size, true);
    view.setUint8(4, ROPEN);
    view.setUint16(5, tag, true);
    this.encodeQid(view, 7, qid);
    view.setUint32(20, iounit, true);
    return buf;
  }

  private encodeRread(tag: number, data: Uint8Array): Uint8Array {
    const size = 4 + 1 + 2 + 4 + data.length;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    view.setUint32(0, size, true);
    view.setUint8(4, RREAD);
    view.setUint16(5, tag, true);
    view.setUint32(7, data.length, true);
    buf.set(data, 11);
    return buf;
  }

  private encodeRwrite(tag: number, count: number): Uint8Array {
    const size = 4 + 1 + 2 + 4;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    view.setUint32(0, size, true);
    view.setUint8(4, RWRITE);
    view.setUint16(5, tag, true);
    view.setUint32(7, count, true);
    return buf;
  }

  private encodeRclunk(tag: number): Uint8Array {
    const size = 4 + 1 + 2;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    view.setUint32(0, size, true);
    view.setUint8(4, RCLUNK);
    view.setUint16(5, tag, true);
    return buf;
  }

  private encodeRstat(tag: number, qid: Qid): Uint8Array {
    // Get the name for this qid
    let name = '';
    if (qid.path === QID_ROOT) name = '/';
    else if (qid.path === QID_DEV) name = 'dev';
    else if (qid.path === QID_CONS) name = 'cons';
    else if (qid.path === QID_CONSCTL) name = 'consctl';

    const stat = this.encodeStat(name, qid);
    const size = 4 + 1 + 2 + 2 + stat.length;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    view.setUint32(0, size, true);
    view.setUint8(4, RSTAT);
    view.setUint16(5, tag, true);
    // stat is prefixed with 2-byte count
    view.setUint16(7, stat.length, true);
    buf.set(stat, 9);
    return buf;
  }

  private encodeError(tag: number, msg: string): Uint8Array {
    const msgBytes = new TextEncoder().encode(msg);
    const size = 4 + 1 + 2 + 2 + msgBytes.length;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    view.setUint32(0, size, true);
    view.setUint8(4, RERROR);
    view.setUint16(5, tag, true);
    view.setUint16(7, msgBytes.length, true);
    buf.set(msgBytes, 9);
    return buf;
  }

  private encodeQid(view: DataView, off: number, qid: Qid): void {
    view.setUint8(off, qid.type);
    view.setUint32(off + 1, qid.vers, true);
    view.setBigUint64(off + 5, qid.path, true);
  }
}

// Message framing helper - accumulates data and yields complete 9P messages
export class MessageFramer {
  private buffer: Uint8Array = new Uint8Array(0);

  push(data: Uint8Array): Uint8Array[] {
    // Append to buffer
    const newBuf = new Uint8Array(this.buffer.length + data.length);
    newBuf.set(this.buffer);
    newBuf.set(data, this.buffer.length);
    this.buffer = newBuf;

    // Extract complete messages
    const messages: Uint8Array[] = [];
    while (this.buffer.length >= 4) {
      const size = new DataView(this.buffer.buffer, this.buffer.byteOffset).getUint32(0, true);
      if (this.buffer.length < size) break;
      messages.push(this.buffer.subarray(0, size));
      this.buffer = this.buffer.subarray(size);
    }
    return messages;
  }
}
