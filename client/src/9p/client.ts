// 9P2000 Client

import { Transport } from '../transport.js';
import { encode, decode } from './messages.js';
import { FidPool } from './fid.js';
import * as T from './types.js';

export type ResponseCallback = (msg: T.AnyRMessage) => void;

export class Client9P {
  private transport: Transport;
  private fidPool = new FidPool();
  private tagCounter = 0;
  private pending = new Map<number, ResponseCallback>();
  private msize = 8192;
  private rootFid = 0;

  constructor(transport: Transport) {
    this.transport = transport;
    this.transport.onMessage = (data) => this.handleMessage(data);
  }

  private allocTag(): number {
    const tag = this.tagCounter++;
    if (this.tagCounter >= T.NOTAG) {
      this.tagCounter = 0;
    }
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
          const rv = r as T.Rversion;
          this.msize = rv.msize;
          resolve(rv);
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
          this.rootFid = fid;
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
      const maxCount = Math.min(count, this.msize - T.IOHDRSZ);
      const msg: T.Tread = {
        type: T.TREAD,
        tag: this.allocTag(),
        fid,
        offset,
        count: maxCount,
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
      const maxData = data.slice(0, this.msize - T.IOHDRSZ);
      const msg: T.Twrite = {
        type: T.TWRITE,
        tag: this.allocTag(),
        fid,
        offset,
        data: maxData,
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

  flush(oldtag: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const msg: T.Tflush = {
        type: T.TFLUSH,
        tag: this.allocTag(),
        oldtag,
      };
      this.send(msg, (r) => {
        if (r.type === T.RERROR) {
          reject(new Error((r as T.Rerror).ename));
        } else {
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

  releaseFid(fid: number): void {
    this.fidPool.release(fid);
  }

  getRootFid(): number {
    return this.rootFid;
  }

  getMsize(): number {
    return this.msize;
  }

  /**
   * Walk to a path and open it.
   * Returns the fid (caller must clunk when done).
   */
  async walkOpen(path: string[], mode: number): Promise<number> {
    const fid = this.allocFid();
    try {
      await this.walk(this.rootFid, fid, path);
      await this.open(fid, mode);
      return fid;
    } catch (e) {
      this.fidPool.release(fid);
      throw e;
    }
  }

  /**
   * Clone a fid (walk with empty path).
   */
  async clone(fid: number): Promise<number> {
    const newfid = this.allocFid();
    try {
      await this.walk(fid, newfid, []);
      return newfid;
    } catch (e) {
      this.fidPool.release(newfid);
      throw e;
    }
  }
}
