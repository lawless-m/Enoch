// 9P2000 Message Encoding/Decoding

import * as T from './types.js';

// ─────────────────────────────────────────────────────────────
// Encoding
// ─────────────────────────────────────────────────────────────

export function encode(msg: T.AnyTMessage): Uint8Array {
  switch (msg.type) {
    case T.TVERSION: return encodeTversion(msg);
    case T.TAUTH:    return encodeTauth(msg);
    case T.TATTACH:  return encodeTattach(msg);
    case T.TFLUSH:   return encodeTflush(msg);
    case T.TWALK:    return encodeTwalk(msg);
    case T.TOPEN:    return encodeTopen(msg);
    case T.TCREATE:  return encodeTcreate(msg);
    case T.TREAD:    return encodeTread(msg);
    case T.TWRITE:   return encodeTwrite(msg);
    case T.TCLUNK:   return encodeTclunk(msg);
    case T.TREMOVE:  return encodeTremove(msg);
    default:
      throw new Error(`Unknown message type: ${(msg as T.TMessage).type}`);
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

function encodeTauth(msg: T.Tauth): Uint8Array {
  const uname = encodeString(msg.uname);
  const aname = encodeString(msg.aname);
  const size = 4 + 1 + 2 + 4 + uname.length + aname.length;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);

  let offset = 0;
  view.setUint32(offset, size, true); offset += 4;
  view.setUint8(offset, msg.type); offset += 1;
  view.setUint16(offset, msg.tag, true); offset += 2;
  view.setUint32(offset, msg.afid, true); offset += 4;
  buf.set(uname, offset); offset += uname.length;
  buf.set(aname, offset);

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

function encodeTflush(msg: T.Tflush): Uint8Array {
  const size = 4 + 1 + 2 + 2;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);

  view.setUint32(0, size, true);
  view.setUint8(4, msg.type);
  view.setUint16(5, msg.tag, true);
  view.setUint16(7, msg.oldtag, true);

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

function encodeTcreate(msg: T.Tcreate): Uint8Array {
  const name = encodeString(msg.name);
  const size = 4 + 1 + 2 + 4 + name.length + 4 + 1;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);

  let offset = 0;
  view.setUint32(offset, size, true); offset += 4;
  view.setUint8(offset, msg.type); offset += 1;
  view.setUint16(offset, msg.tag, true); offset += 2;
  view.setUint32(offset, msg.fid, true); offset += 4;
  buf.set(name, offset); offset += name.length;
  view.setUint32(offset, msg.perm, true); offset += 4;
  view.setUint8(offset, msg.mode);

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

function encodeTremove(msg: T.Tremove): Uint8Array {
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
    case T.RFLUSH:   return { type: T.RFLUSH, tag } as T.Rflush;
    case T.RWALK:    return decodeRwalk(view, tag);
    case T.ROPEN:    return decodeRopen(view, tag);
    case T.RCREATE:  return decodeRcreate(view, tag);
    case T.RREAD:    return decodeRread(view, tag, data);
    case T.RWRITE:   return decodeRwrite(view, tag);
    case T.RCLUNK:   return { type: T.RCLUNK, tag } as T.Rclunk;
    case T.RREMOVE:  return { type: T.RREMOVE, tag } as T.Rremove;
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

function decodeRversion(view: DataView, tag: number): T.Rversion {
  const msize = view.getUint32(7, true);
  const { str: version } = decodeString(view, 11);
  return { type: T.RVERSION, tag, msize, version };
}

function decodeRauth(view: DataView, tag: number): T.Rauth {
  const aqid = decodeQid(view, 7);
  return { type: T.RAUTH, tag, aqid };
}

function decodeRattach(view: DataView, tag: number): T.Rattach {
  const qid = decodeQid(view, 7);
  return { type: T.RATTACH, tag, qid };
}

function decodeRerror(view: DataView, tag: number): T.Rerror {
  const { str: ename } = decodeString(view, 7);
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

function decodeRcreate(view: DataView, tag: number): T.Rcreate {
  const qid = decodeQid(view, 7);
  const iounit = view.getUint32(20, true);
  return { type: T.RCREATE, tag, qid, iounit };
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

function decodeString(view: DataView, offset: number): { str: string; end: number } {
  const len = view.getUint16(offset, true);
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset + 2, len);
  return {
    str: new TextDecoder().decode(bytes),
    end: offset + 2 + len,
  };
}
