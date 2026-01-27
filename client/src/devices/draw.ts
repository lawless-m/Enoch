// /dev/draw - Graphics device
// Handles the /dev/draw file hierarchy over 9P

import { Client9P } from '../9p/client.js';
import { OREAD, ORDWR } from '../9p/types.js';
import { DrawRenderer } from '../draw/renderer.js';
import { parseCtl } from '../draw/protocol.js';
import type { Rectangle, ImageInfo } from '../draw/types.js';

export class DrawDevice {
  private client: Client9P;
  private renderer: DrawRenderer;

  // File handles
  private newFid: number | null = null;
  private ctlFid: number | null = null;
  private dataFid: number | null = null;
  private refreshFid: number | null = null;

  // Client info from /dev/draw/new
  private clientId: number = -1;

  // Callbacks
  public onRefresh?: (r: Rectangle) => void;

  constructor(client: Client9P, canvas: HTMLCanvasElement) {
    this.client = client;
    this.renderer = new DrawRenderer(canvas);

    // Wire up flush callback
    this.renderer.onFlush = (r) => {
      this.onRefresh?.(r);
    };
  }

  /**
   * Initialize the draw device by opening /dev/draw/new
   * and then the client-specific files.
   */
  async init(): Promise<ImageInfo> {
    // Open /dev/draw/new to get a client ID
    const newFid = await this.client.walkOpen(['dev', 'draw', 'new'], OREAD);

    try {
      // Read client info (144 bytes: 12 fields * 12 chars)
      const data = await this.client.read(newFid, 0n, 256);
      const info = new TextDecoder().decode(data);
      const parsed = parseCtl(info);

      this.clientId = parsed.clientId;

      // Now open the client-specific files
      const clientDir = this.clientId.toString();

      this.ctlFid = await this.client.walkOpen(
        ['dev', 'draw', clientDir, 'ctl'], OREAD
      );

      this.dataFid = await this.client.walkOpen(
        ['dev', 'draw', clientDir, 'data'], ORDWR
      );

      // Optionally open refresh for resize events
      try {
        this.refreshFid = await this.client.walkOpen(
          ['dev', 'draw', clientDir, 'refresh'], OREAD
        );
      } catch {
        // refresh file is optional
      }

      return {
        clientId: parsed.clientId,
        imageId: parsed.imageId,
        chan: parsed.chan,
        repl: parsed.repl !== 0,
        r: parsed.r,
        clipr: parsed.clipr,
      };
    } finally {
      await this.client.clunk(newFid);
    }
  }

  /**
   * Send draw commands to the server.
   * Commands are written to /dev/draw/n/data.
   */
  async sendCommands(data: Uint8Array): Promise<Uint8Array> {
    if (this.dataFid === null) {
      throw new Error('Draw device not initialized');
    }

    // Write commands
    await this.client.write(this.dataFid, 0n, data);

    // Read response (some commands return data)
    const response = await this.client.read(this.dataFid, 0n, 8192);
    return response;
  }

  /**
   * Read current ctl info (display dimensions, channel format, etc.)
   */
  async readCtl(): Promise<ImageInfo> {
    if (this.ctlFid === null) {
      throw new Error('Draw device not initialized');
    }

    const data = await this.client.read(this.ctlFid, 0n, 256);
    const info = new TextDecoder().decode(data);
    const parsed = parseCtl(info);

    return {
      clientId: parsed.clientId,
      imageId: parsed.imageId,
      chan: parsed.chan,
      repl: parsed.repl !== 0,
      r: parsed.r,
      clipr: parsed.clipr,
    };
  }

  /**
   * Start listening for refresh events.
   * Refresh events indicate the screen needs to be redrawn.
   */
  startRefreshLoop(): void {
    if (this.refreshFid === null) return;
    this.refreshLoop();
  }

  private async refreshLoop(): Promise<void> {
    while (this.refreshFid !== null) {
      try {
        // Read refresh rectangle (16 bytes: min.x, min.y, max.x, max.y)
        const data = await this.client.read(this.refreshFid, 0n, 16);
        if (data.length >= 16) {
          const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
          const r: Rectangle = {
            minX: view.getInt32(0, true),
            minY: view.getInt32(4, true),
            maxX: view.getInt32(8, true),
            maxY: view.getInt32(12, true),
          };
          this.onRefresh?.(r);
        }
      } catch (e) {
        // Refresh read failed - might be closed
        if (this.refreshFid !== null) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
  }

  /**
   * Get the renderer for local draw operations.
   */
  getRenderer(): DrawRenderer {
    return this.renderer;
  }

  /**
   * Resize the screen canvas.
   */
  resize(width: number, height: number): void {
    this.renderer.resize(width, height);
  }

  /**
   * Close the draw device.
   */
  async close(): Promise<void> {
    const fids = [this.ctlFid, this.dataFid, this.refreshFid];
    this.ctlFid = null;
    this.dataFid = null;
    this.refreshFid = null;

    for (const fid of fids) {
      if (fid !== null) {
        try {
          await this.client.clunk(fid);
        } catch {
          // Ignore clunk errors on close
        }
      }
    }
  }
}

/**
 * Local-only draw device for testing without 9P connection.
 * Processes commands directly on the client-side renderer.
 */
export class LocalDrawDevice {
  private renderer: DrawRenderer;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new DrawRenderer(canvas);
  }

  /**
   * Process draw commands locally.
   */
  processCommands(data: Uint8Array): Uint8Array {
    return this.renderer.processCommands(data);
  }

  /**
   * Get the renderer.
   */
  getRenderer(): DrawRenderer {
    return this.renderer;
  }

  /**
   * Resize the canvas.
   */
  resize(width: number, height: number): void {
    this.renderer.resize(width, height);
  }

  /**
   * Set flush callback.
   */
  set onFlush(callback: ((r: Rectangle) => void) | undefined) {
    this.renderer.onFlush = callback;
  }
}
