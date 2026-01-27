// Plan 9 keyboard handling
// Maps browser keyboard events to Plan 9 key codes

// Plan 9 special keys (Unicode private use area)
export const Key = {
  // Arrow keys
  Up: 0xF800,
  Down: 0xF801,
  Left: 0xF802,
  Right: 0xF803,

  // Navigation
  Home: 0xF804,
  End: 0xF805,
  PageUp: 0xF806,
  PageDown: 0xF807,
  Insert: 0xF808,

  // Modifiers (for reference, not usually sent as characters)
  Shift: 0xF809,
  Ctrl: 0xF80A,
  Alt: 0xF80B,
  Meta: 0xF80C,

  // Function keys
  F1: 0xF810,
  F2: 0xF811,
  F3: 0xF812,
  F4: 0xF813,
  F5: 0xF814,
  F6: 0xF815,
  F7: 0xF816,
  F8: 0xF817,
  F9: 0xF818,
  F10: 0xF819,
  F11: 0xF81A,
  F12: 0xF81B,

  // Control characters
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0A,    // newline
  Escape: 0x1B,
  Delete: 0x7F,

  // acme/sam specific (sometimes used)
  ScrollUp: 0xF80D,
  ScrollDown: 0xF80E,

  // Break
  Break: 0xF80F,
} as const;

/**
 * Convert a browser KeyboardEvent to Plan 9 key code(s).
 * Returns an array of key codes (may be empty for unhandled keys,
 * or multiple for composed characters).
 */
export function keyEventToPlan9(e: KeyboardEvent): number[] {
  // Handle Ctrl+key combinations
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    const code = ctrlKeyCode(e.key, e.code);
    if (code !== null) {
      return [code];
    }
  }

  // Handle special keys
  const special = specialKeyCode(e.code);
  if (special !== null) {
    return [special];
  }

  // Regular character input - let the 'input' event handle it
  // Return empty to indicate this key doesn't generate a code directly
  return [];
}

/**
 * Get Ctrl+key code.
 */
function ctrlKeyCode(key: string, code: string): number | null {
  // Ctrl+A through Ctrl+Z = 1-26
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') {
      return upper.charCodeAt(0) - 'A'.charCodeAt(0) + 1;
    }
  }

  // Ctrl+[ = Escape (0x1B)
  if (key === '[') return 0x1B;
  // Ctrl+\ = 0x1C (FS)
  if (key === '\\') return 0x1C;
  // Ctrl+] = 0x1D (GS)
  if (key === ']') return 0x1D;
  // Ctrl+^ = 0x1E (RS)
  if (key === '^' || key === '6') return 0x1E;
  // Ctrl+_ = 0x1F (US)
  if (key === '_' || key === '-') return 0x1F;
  // Ctrl+? = 0x7F (DEL) - sometimes
  if (key === '?') return 0x7F;

  // Ctrl+Space = 0 (NUL)
  if (code === 'Space') return 0;

  return null;
}

/**
 * Get special key code from keyboard event code.
 */
function specialKeyCode(code: string): number | null {
  switch (code) {
    // Arrow keys
    case 'ArrowUp': return Key.Up;
    case 'ArrowDown': return Key.Down;
    case 'ArrowLeft': return Key.Left;
    case 'ArrowRight': return Key.Right;

    // Navigation
    case 'Home': return Key.Home;
    case 'End': return Key.End;
    case 'PageUp': return Key.PageUp;
    case 'PageDown': return Key.PageDown;
    case 'Insert': return Key.Insert;

    // Editing
    case 'Backspace': return Key.Backspace;
    case 'Delete': return Key.Delete;
    case 'Tab': return Key.Tab;
    case 'Enter': case 'NumpadEnter': return Key.Enter;
    case 'Escape': return Key.Escape;

    // Function keys
    case 'F1': return Key.F1;
    case 'F2': return Key.F2;
    case 'F3': return Key.F3;
    case 'F4': return Key.F4;
    case 'F5': return Key.F5;
    case 'F6': return Key.F6;
    case 'F7': return Key.F7;
    case 'F8': return Key.F8;
    case 'F9': return Key.F9;
    case 'F10': return Key.F10;
    case 'F11': return Key.F11;
    case 'F12': return Key.F12;

    default: return null;
  }
}

/**
 * Encode a Plan 9 key code as UTF-8 bytes.
 * Plan 9 uses UTF-8, so codes > 127 become multi-byte sequences.
 */
export function encodeKeyCode(code: number): Uint8Array {
  if (code < 0x80) {
    return new Uint8Array([code]);
  } else if (code < 0x800) {
    return new Uint8Array([
      0xC0 | (code >> 6),
      0x80 | (code & 0x3F),
    ]);
  } else if (code < 0x10000) {
    return new Uint8Array([
      0xE0 | (code >> 12),
      0x80 | ((code >> 6) & 0x3F),
      0x80 | (code & 0x3F),
    ]);
  } else {
    return new Uint8Array([
      0xF0 | (code >> 18),
      0x80 | ((code >> 12) & 0x3F),
      0x80 | ((code >> 6) & 0x3F),
      0x80 | (code & 0x3F),
    ]);
  }
}

/**
 * Keyboard capture that handles both special keys and text input.
 */
export class KeyboardCapture {
  private element: HTMLElement;
  private onKey: (data: Uint8Array) => void;

  constructor(element: HTMLElement, onKey: (data: Uint8Array) => void) {
    this.element = element;
    this.onKey = onKey;
    this.attach();
  }

  private attach(): void {
    // Use keydown for special keys
    this.element.addEventListener('keydown', this.handleKeyDown);

    // Use input event for text (handles IME, dead keys, etc.)
    // But we need a text input element for this...
    // For a canvas, we handle everything in keydown
  }

  detach(): void {
    this.element.removeEventListener('keydown', this.handleKeyDown);
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    const codes = keyEventToPlan9(e);

    if (codes.length > 0) {
      // Special key or Ctrl combo - prevent default and send
      e.preventDefault();
      for (const code of codes) {
        this.onKey(encodeKeyCode(code));
      }
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Regular printable character
      e.preventDefault();
      this.onKey(new TextEncoder().encode(e.key));
    }
    // Else: let browser handle (e.g., Ctrl+C for copy)
  };
}
