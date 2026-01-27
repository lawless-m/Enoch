// /dev/mouse - Mouse device
// Plan 9 mouse protocol over 9P

import { Client9P } from '../9p/client.js';
import { ORDWR } from '../9p/types.js';

// Mouse button flags (Plan 9 style)
export const MouseButton = {
  None: 0,
  Button1: 1,   // Left
  Button2: 2,   // Middle
  Button3: 4,   // Right
  Button4: 8,   // Scroll up
  Button5: 16,  // Scroll down
} as const;

export interface MouseState {
  x: number;
  y: number;
  buttons: number;
  msec: number;
}

export class MouseDevice {
  private client: Client9P;
  private fid: number | null = null;
  private reading = false;
  private onEvent: ((state: MouseState) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;

  // Current state (for sending to server)
  private x = 0;
  private y = 0;
  private buttons = 0;

  constructor(client: Client9P) {
    this.client = client;
  }

  async open(): Promise<void> {
    this.fid = await this.client.walkOpen(['dev', 'mouse'], ORDWR);
  }

  async close(): Promise<void> {
    if (this.fid !== null) {
      this.reading = false;
      await this.client.clunk(this.fid);
      this.fid = null;
    }
  }

  setEventHandler(handler: (state: MouseState) => void): void {
    this.onEvent = handler;
  }

  setErrorHandler(handler: (error: Error) => void): void {
    this.onError = handler;
  }

  /**
   * Start reading mouse events from server.
   * This is for receiving cursor warp requests from Plan 9 apps.
   */
  startReading(): void {
    if (this.fid === null) {
      throw new Error('Mouse device not open');
    }
    this.reading = true;
    this.readLoop();
  }

  stopReading(): void {
    this.reading = false;
  }

  private async readLoop(): Promise<void> {
    while (this.reading && this.fid !== null) {
      try {
        // Mouse state is 49 bytes: "m%11d %11d %11d %11d "
        const data = await this.client.read(this.fid, 0n, 49);
        if (data.length >= 49) {
          const state = parseMouseState(data);
          if (state && this.onEvent) {
            this.onEvent(state);
          }
        }
      } catch (e) {
        if (this.reading && this.onError) {
          this.onError(e instanceof Error ? e : new Error(String(e)));
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }

  /**
   * Send mouse state to server.
   * Call this when the browser mouse moves or buttons change.
   */
  async sendState(x: number, y: number, buttons: number): Promise<void> {
    if (this.fid === null) {
      throw new Error('Mouse device not open');
    }

    this.x = x;
    this.y = y;
    this.buttons = buttons;

    const data = formatMouseState({
      x,
      y,
      buttons,
      msec: Date.now() % 100000000000,
    });

    await this.client.write(this.fid, 0n, data);
  }

  /**
   * Send mouse move event.
   */
  async move(x: number, y: number): Promise<void> {
    await this.sendState(x, y, this.buttons);
  }

  /**
   * Send button press event.
   */
  async buttonDown(button: number): Promise<void> {
    await this.sendState(this.x, this.y, this.buttons | button);
  }

  /**
   * Send button release event.
   */
  async buttonUp(button: number): Promise<void> {
    await this.sendState(this.x, this.y, this.buttons & ~button);
  }

  /**
   * Send scroll event (button 4 or 5, then release).
   */
  async scroll(deltaY: number): Promise<void> {
    const button = deltaY < 0 ? MouseButton.Button4 : MouseButton.Button5;
    // Press and release scroll button
    await this.sendState(this.x, this.y, this.buttons | button);
    await this.sendState(this.x, this.y, this.buttons & ~button);
  }
}

/**
 * Parse Plan 9 mouse state from 49-byte format.
 * Format: "m%11d %11d %11d %11d " (x, y, buttons, msec)
 */
export function parseMouseState(data: Uint8Array): MouseState | null {
  if (data.length < 49 || data[0] !== 0x6D) { // 'm'
    return null;
  }

  const str = new TextDecoder().decode(data);
  const match = str.match(/^m\s*(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)/);
  if (!match) {
    return null;
  }

  return {
    x: parseInt(match[1], 10),
    y: parseInt(match[2], 10),
    buttons: parseInt(match[3], 10),
    msec: parseInt(match[4], 10),
  };
}

/**
 * Format mouse state to Plan 9 49-byte format.
 */
export function formatMouseState(state: MouseState): Uint8Array {
  // Format: "m%11d %11d %11d %11d "
  const str = 'm' +
    state.x.toString().padStart(11) + ' ' +
    state.y.toString().padStart(11) + ' ' +
    state.buttons.toString().padStart(11) + ' ' +
    (state.msec % 100000000000).toString().padStart(11) + ' ';
  return new TextEncoder().encode(str);
}

/**
 * Local mouse handler for capturing browser mouse events.
 * Attach to a canvas element to capture mouse input.
 */
export class MouseCapture {
  private element: HTMLElement;
  private onState: (x: number, y: number, buttons: number) => void;
  private buttons = 0;

  constructor(element: HTMLElement, onState: (x: number, y: number, buttons: number) => void) {
    this.element = element;
    this.onState = onState;
    this.attach();
  }

  private attach(): void {
    this.element.addEventListener('mousemove', this.handleMove);
    this.element.addEventListener('mousedown', this.handleDown);
    this.element.addEventListener('mouseup', this.handleUp);
    this.element.addEventListener('wheel', this.handleWheel);
    this.element.addEventListener('contextmenu', this.handleContextMenu);
  }

  detach(): void {
    this.element.removeEventListener('mousemove', this.handleMove);
    this.element.removeEventListener('mousedown', this.handleDown);
    this.element.removeEventListener('mouseup', this.handleUp);
    this.element.removeEventListener('wheel', this.handleWheel);
    this.element.removeEventListener('contextmenu', this.handleContextMenu);
  }

  private handleMove = (e: MouseEvent): void => {
    const rect = this.element.getBoundingClientRect();
    const x = Math.round(e.clientX - rect.left);
    const y = Math.round(e.clientY - rect.top);
    this.onState(x, y, this.buttons);
  };

  private handleDown = (e: MouseEvent): void => {
    const button = browserButtonToPlan9(e.button);
    this.buttons |= button;

    const rect = this.element.getBoundingClientRect();
    const x = Math.round(e.clientX - rect.left);
    const y = Math.round(e.clientY - rect.top);
    this.onState(x, y, this.buttons);
  };

  private handleUp = (e: MouseEvent): void => {
    const button = browserButtonToPlan9(e.button);
    this.buttons &= ~button;

    const rect = this.element.getBoundingClientRect();
    const x = Math.round(e.clientX - rect.left);
    const y = Math.round(e.clientY - rect.top);
    this.onState(x, y, this.buttons);
  };

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.element.getBoundingClientRect();
    const x = Math.round(e.clientX - rect.left);
    const y = Math.round(e.clientY - rect.top);

    // Scroll up = button 4, scroll down = button 5
    const button = e.deltaY < 0 ? MouseButton.Button4 : MouseButton.Button5;

    // Send press and release
    this.onState(x, y, this.buttons | button);
    // Small delay then release (or just release immediately)
    this.onState(x, y, this.buttons);
  };

  private handleContextMenu = (e: Event): void => {
    e.preventDefault(); // Prevent browser context menu
  };
}

/**
 * Convert browser mouse button to Plan 9 button flag.
 */
function browserButtonToPlan9(button: number): number {
  switch (button) {
    case 0: return MouseButton.Button1; // Left
    case 1: return MouseButton.Button2; // Middle
    case 2: return MouseButton.Button3; // Right
    default: return 0;
  }
}
