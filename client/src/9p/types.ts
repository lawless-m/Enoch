// 9P2000 Protocol Constants and Types

// Special values
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

// QID type flags
export const QTDIR = 0x80;
export const QTAPPEND = 0x40;
export const QTEXCL = 0x20;
export const QTAUTH = 0x08;
export const QTTMP = 0x04;
export const QTFILE = 0x00;

// QID structure (13 bytes)
export interface Qid {
  type: number;    // 1 byte
  vers: number;    // 4 bytes
  path: bigint;    // 8 bytes
}

// Message interfaces
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

export interface Tflush extends TMessage {
  type: typeof TFLUSH;
  oldtag: number;
}

export interface Rflush extends RMessage {
  type: typeof RFLUSH;
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

export interface Tcreate extends TMessage {
  type: typeof TCREATE;
  fid: number;
  name: string;
  perm: number;
  mode: number;
}

export interface Rcreate extends RMessage {
  type: typeof RCREATE;
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

export interface Tremove extends TMessage {
  type: typeof TREMOVE;
  fid: number;
}

export interface Rremove extends RMessage {
  type: typeof RREMOVE;
}

// Union types for all messages
export type AnyTMessage =
  | Tversion | Tauth | Tattach | Tflush | Twalk
  | Topen | Tcreate | Tread | Twrite | Tclunk | Tremove;

export type AnyRMessage =
  | Rversion | Rauth | Rattach | Rerror | Rflush | Rwalk
  | Ropen | Rcreate | Rread | Rwrite | Rclunk | Rremove;
