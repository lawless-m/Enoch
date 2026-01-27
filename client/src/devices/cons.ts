// /dev/cons and /dev/consctl - Console device

import { Client9P } from '../9p/client.js';
import { ORDWR, OWRITE } from '../9p/types.js';

export class ConsDevice {
  private client: Client9P;
  private fid: number | null = null;
  private ctlFid: number | null = null;
  private reading = false;
  private onData: ((data: Uint8Array) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;

  // Raw mode state
  private _rawMode = false;

  constructor(client: Client9P) {
    this.client = client;
  }

  async open(): Promise<void> {
    this.fid = await this.client.walkOpen(['dev', 'cons'], ORDWR);

    // Try to open consctl (may not exist on all servers)
    try {
      this.ctlFid = await this.client.walkOpen(['dev', 'consctl'], OWRITE);
    } catch {
      // consctl not available - that's ok
      this.ctlFid = null;
    }
  }

  /**
   * Enable or disable raw mode.
   * In raw mode, input is not line-buffered and no local echo.
   */
  async setRawMode(raw: boolean): Promise<void> {
    if (this.ctlFid === null) {
      // No consctl - just track locally
      this._rawMode = raw;
      return;
    }

    const cmd = raw ? 'rawon' : 'rawoff';
    const data = new TextEncoder().encode(cmd);
    await this.client.write(this.ctlFid, 0n, data);
    this._rawMode = raw;
  }

  get rawMode(): boolean {
    return this._rawMode;
  }

  async close(): Promise<void> {
    this.reading = false;

    if (this.ctlFid !== null) {
      try {
        await this.client.clunk(this.ctlFid);
      } catch { /* ignore */ }
      this.ctlFid = null;
    }

    if (this.fid !== null) {
      await this.client.clunk(this.fid);
      this.fid = null;
    }
  }

  setDataHandler(handler: (data: Uint8Array) => void): void {
    this.onData = handler;
  }

  setErrorHandler(handler: (error: Error) => void): void {
    this.onError = handler;
  }

  /**
   * Start reading from console with pipelining.
   * Keeps N read requests outstanding for better throughput.
   */
  startReading(pipelineDepth: number = 2): void {
    if (this.fid === null) {
      throw new Error('Console not open');
    }

    this.reading = true;

    // Start pipelined reads
    for (let i = 0; i < pipelineDepth; i++) {
      this.readLoop();
    }
  }

  stopReading(): void {
    this.reading = false;
  }

  private async readLoop(): Promise<void> {
    while (this.reading && this.fid !== null) {
      try {
        // Read at offset 0 (cons is streaming, offset ignored)
        const data = await this.client.read(this.fid, 0n, 8192);
        if (data.length > 0 && this.onData) {
          this.onData(data);
        }
      } catch (e) {
        if (this.reading && this.onError) {
          this.onError(e instanceof Error ? e : new Error(String(e)));
        }
        // Small delay before retry on error
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }

  /**
   * Write data to console.
   */
  async write(data: Uint8Array): Promise<void> {
    if (this.fid === null) {
      throw new Error('Console not open');
    }

    let offset = 0;
    while (offset < data.length) {
      const written = await this.client.write(this.fid, 0n, data.slice(offset));
      offset += written;
    }
  }

  /**
   * Write a string to console.
   */
  async writeString(s: string): Promise<void> {
    const data = new TextEncoder().encode(s);
    await this.write(data);
  }
}
