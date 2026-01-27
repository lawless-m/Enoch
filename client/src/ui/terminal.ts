// Terminal UI - display and keyboard input

import { Key, keyEventToPlan9, encodeKeyCode } from '../input/keyboard.js';

// Keyboard mode: plan9 sends Plan 9 special keys, ansi sends escape sequences
export type KeyboardMode = 'plan9' | 'ansi';

export class Terminal {
  private element: HTMLPreElement;
  private buffer: string = '';
  private maxLines: number;
  private onInput: ((data: Uint8Array) => void) | null = null;

  // Keyboard mode - 'plan9' for native Plan 9 apps, 'ansi' for Unix tools
  public keyboardMode: KeyboardMode = 'plan9';

  constructor(elementId: string, maxLines: number = 10000) {
    const el = document.getElementById(elementId);
    if (!el || !(el instanceof HTMLPreElement)) {
      throw new Error(`Element #${elementId} not found or not a <pre>`);
    }
    this.element = el;
    this.maxLines = maxLines;

    // Capture keyboard input
    document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    document.addEventListener('keypress', (e) => this.handleKeyPress(e));

    // Make element focusable and focus it
    this.element.tabIndex = 0;
    this.element.focus();
  }

  setInputHandler(handler: (data: Uint8Array) => void): void {
    this.onInput = handler;
  }

  /**
   * Write data to terminal display.
   */
  write(data: Uint8Array): void {
    const text = new TextDecoder().decode(data);
    this.writeText(text);
  }

  /**
   * Write text to terminal display.
   */
  writeText(text: string): void {
    this.buffer += text;

    // Limit buffer size
    const lines = this.buffer.split('\n');
    if (lines.length > this.maxLines) {
      this.buffer = lines.slice(-this.maxLines).join('\n');
    }

    this.element.textContent = this.buffer;
    this.scrollToBottom();
  }

  /**
   * Clear terminal.
   */
  clear(): void {
    this.buffer = '';
    this.element.textContent = '';
  }

  private scrollToBottom(): void {
    this.element.scrollTop = this.element.scrollHeight;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    let data: Uint8Array | null = null;

    // Try Plan 9 key mapping first (handles Ctrl+key and special keys)
    const plan9Codes = keyEventToPlan9(e);
    if (plan9Codes.length > 0) {
      if (this.keyboardMode === 'plan9') {
        // Send Plan 9 special key codes
        const bytes: number[] = [];
        for (const code of plan9Codes) {
          bytes.push(...encodeKeyCode(code));
        }
        data = new Uint8Array(bytes);
      } else {
        // ANSI mode - convert special keys to escape sequences
        data = this.keyToAnsi(e.code, plan9Codes[0]);
      }
      e.preventDefault();
    } else {
      // Handle keys that need special treatment regardless of mode
      switch (e.key) {
        case 'Tab':
          data = new Uint8Array([0x09]);
          e.preventDefault();
          break;

        case 'Escape':
          data = new Uint8Array([0x1b]);
          e.preventDefault();
          break;
      }
    }

    if (data && this.onInput) {
      this.onInput(data);
    }
  }

  /**
   * Convert a key code to ANSI escape sequence.
   */
  private keyToAnsi(code: string, plan9Code: number): Uint8Array | null {
    const encoder = new TextEncoder();

    switch (plan9Code) {
      case Key.Up: return encoder.encode('\x1b[A');
      case Key.Down: return encoder.encode('\x1b[B');
      case Key.Right: return encoder.encode('\x1b[C');
      case Key.Left: return encoder.encode('\x1b[D');
      case Key.Home: return encoder.encode('\x1b[H');
      case Key.End: return encoder.encode('\x1b[F');
      case Key.PageUp: return encoder.encode('\x1b[5~');
      case Key.PageDown: return encoder.encode('\x1b[6~');
      case Key.Insert: return encoder.encode('\x1b[2~');
      case Key.Delete: return new Uint8Array([0x7f]);
      case Key.Backspace: return new Uint8Array([0x7f]);
      case Key.Enter: return new Uint8Array([0x0a]);

      // Function keys
      case Key.F1: return encoder.encode('\x1bOP');
      case Key.F2: return encoder.encode('\x1bOQ');
      case Key.F3: return encoder.encode('\x1bOR');
      case Key.F4: return encoder.encode('\x1bOS');
      case Key.F5: return encoder.encode('\x1b[15~');
      case Key.F6: return encoder.encode('\x1b[17~');
      case Key.F7: return encoder.encode('\x1b[18~');
      case Key.F8: return encoder.encode('\x1b[19~');
      case Key.F9: return encoder.encode('\x1b[20~');
      case Key.F10: return encoder.encode('\x1b[21~');
      case Key.F11: return encoder.encode('\x1b[23~');
      case Key.F12: return encoder.encode('\x1b[24~');

      default:
        // For Ctrl+key, the plan9Code is already the control character
        if (plan9Code < 32) {
          return new Uint8Array([plan9Code]);
        }
        return null;
    }
  }

  private handleKeyPress(e: KeyboardEvent): void {
    // Don't handle if modifier keys are pressed (except shift)
    if (e.ctrlKey || e.altKey || e.metaKey) {
      return;
    }

    // Handle Enter
    if (e.key === 'Enter') {
      if (this.onInput) {
        this.onInput(new Uint8Array([0x0a])); // LF
      }
      e.preventDefault();
      return;
    }

    // Handle regular character input
    if (e.key.length === 1) {
      if (this.onInput) {
        this.onInput(new TextEncoder().encode(e.key));
      }
      e.preventDefault();
    }
  }
}
