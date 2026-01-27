// Fid pool - allocates and releases file handles

import { NOFID } from './types.js';

export class FidPool {
  private next = 0;
  private free: number[] = [];

  alloc(): number {
    if (this.free.length > 0) {
      return this.free.pop()!;
    }
    const fid = this.next++;
    if (fid >= NOFID) {
      throw new Error('Fid pool exhausted');
    }
    return fid;
  }

  release(fid: number): void {
    this.free.push(fid);
  }
}
