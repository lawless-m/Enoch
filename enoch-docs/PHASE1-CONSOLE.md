# Phase 1: Console

The first milestone is a working text terminal over unauthenticated 9P. Get bytes flowing before adding complexity.

## Goal

A browser-based terminal that:
- Connects to 9front via WebSocket
- Opens /dev/cons
- Displays output
- Accepts keyboard input

## Architecture

```
┌─────────────────────────────────────────┐
│              Browser                    │
│  ┌───────────────────────────────────┐ │
│  │         terminal.ts                │ │
│  │  ┌─────────────┐  ┌────────────┐  │ │
│  │  │  <pre> for  │  │  Keyboard  │  │ │
│  │  │  output     │  │  listener  │  │ │
│  │  └──────┬──────┘  └─────┬──────┘  │ │
│  │         │               │          │ │
│  │         ▼               ▼          │ │
│  │  ┌─────────────────────────────┐  │ │
│  │  │         cons.ts             │  │ │
│  │  │   Tread ← screen buffer     │  │ │
│  │  │   Twrite ← keystrokes       │  │ │
│  │  └─────────────┬───────────────┘  │ │
│  │                │                   │ │
│  │  ┌─────────────▼───────────────┐  │ │
│  │  │       9p/client.ts          │  │ │
│  │  │   Message encode/decode     │  │ │
│  │  │   Fid management            │  │ │
│  │  │   Tag tracking              │  │ │
│  │  └─────────────┬───────────────┘  │ │
│  │                │                   │ │
│  │  ┌─────────────▼───────────────┐  │ │
│  │  │       transport.ts          │  │ │
│  │  │   WebSocket management      │  │ │
│  │  │   Reconnection logic        │  │ │
│  │  └─────────────┬───────────────┘  │ │
│  └────────────────┼───────────────────┘ │
└───────────────────┼─────────────────────┘
                    │ wss://
                    ▼
┌─────────────────────────────────────────┐
│              9front                     │
│  ┌───────────────────────────────────┐ │
│  │           enoch.c                  │ │
│  │   Listen → Accept → Fork          │ │
│  │   HTTP upgrade                     │ │
│  │   WebSocket ↔ exportfs -n          │ │
│  └───────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

## Server Setup (9front)

For Phase 1, use `exportfs -n` (no auth) for testing:

```sh
# In the trampoline, connect to:
exportfs -n -r /
```

Or export just /dev:

```sh
exportfs -n -r /dev
```

The trampoline connects to exportfs on localhost, bridges WebSocket.

## Connection Sequence

### 1. WebSocket Connect

```typescript
const ws = new WebSocket('wss://9front.local:8080/cpu');
ws.binaryType = 'arraybuffer';
```

### 2. Version Negotiation

```typescript
// Client
send(Tversion(tag=NOTAG, msize=8192, version="9P2000"));

// Server response
Rversion(tag=NOTAG, msize=8192, version="9P2000")
```

### 3. Attach (No Auth)

```typescript
// Client - NOFID for afid means no authentication
send(Tattach(tag=0, fid=ROOT_FID, afid=NOFID, uname="glenda", aname=""));

// Server response
Rattach(tag=0, qid={...})
```

### 4. Walk to /dev/cons

```typescript
// Client
send(Twalk(tag=1, fid=ROOT_FID, newfid=CONS_FID, wnames=["dev", "cons"]));

// Server response
Rwalk(tag=1, qids=[qid_dev, qid_cons])
```

### 5. Open for Read/Write

```typescript
// Client
send(Topen(tag=2, fid=CONS_FID, mode=ORDWR));

// Server response
Ropen(tag=2, qid={...}, iounit=0)
```

### 6. Read Loop

```typescript
// Continuously read from cons
send(Tread(tag=nextTag(), fid=CONS_FID, offset=0n, count=8192));

// Server response with output
Rread(tag=N, count=X, data=[...])

// Display data, send another read
```

### 7. Write Keystrokes

```typescript
// When user types
send(Twrite(tag=nextTag(), fid=CONS_FID, offset=0n, count=data.length, data));

// Server response
Rwrite(tag=N, count=X)
```

## Fid Allocation

Simple strategy for Phase 1:

| Fid | Purpose |
|-----|---------|
| 0 | Root (from attach) |
| 1 | /dev/cons |
| 2+ | Future use |

```typescript
class FidPool {
  private next = 0;
  private free: number[] = [];
  
  alloc(): number {
    return this.free.pop() ?? this.next++;
  }
  
  release(fid: number): void {
    this.free.push(fid);
  }
}
```

## Tag Management

Tags must be unique per outstanding request:

```typescript
class TagPool {
  private next = 0;
  private pending = new Map<number, (msg: RMessage) => void>();
  
  alloc(callback: (msg: RMessage) => void): number {
    const tag = this.next++;
    if (this.next > 0xFFFE) this.next = 0;  // Wrap, skip NOTAG
    this.pending.set(tag, callback);
    return tag;
  }
  
  complete(tag: number, msg: RMessage): void {
    const callback = this.pending.get(tag);
    if (callback) {
      this.pending.delete(tag);
      callback(msg);
    }
  }
}
```

## Terminal Display

Simple approach using `<pre>`:

```html
<div id="terminal">
  <pre id="output"></pre>
  <input id="input" type="text" autofocus>
</div>
```

```typescript
class Terminal {
  private output: HTMLPreElement;
  private buffer = '';
  
  constructor(element: HTMLPreElement) {
    this.output = element;
  }
  
  write(data: Uint8Array): void {
    const text = new TextDecoder().decode(data);
    this.buffer += text;
    this.output.textContent = this.buffer;
    this.scrollToBottom();
  }
  
  private scrollToBottom(): void {
    this.output.scrollTop = this.output.scrollHeight;
  }
}
```

## Keyboard Handling

Capture keystrokes and send to cons:

```typescript
class ConsInput {
  private cons: ConsFid;
  
  constructor(cons: ConsFid, input: HTMLInputElement) {
    input.addEventListener('keydown', (e) => this.handleKey(e));
  }
  
  private handleKey(e: KeyboardEvent): void {
    let data: string | null = null;
    
    switch (e.key) {
      case 'Enter':
        data = '\n';
        break;
      case 'Backspace':
        data = '\x7f';  // DEL
        break;
      case 'Tab':
        data = '\t';
        e.preventDefault();
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
          data = e.key;
        } else if (e.ctrlKey && e.key.length === 1) {
          // Ctrl+C = 0x03, Ctrl+D = 0x04, etc.
          const code = e.key.toUpperCase().charCodeAt(0) - 64;
          if (code >= 1 && code <= 26) {
            data = String.fromCharCode(code);
          }
        }
    }
    
    if (data !== null) {
      this.cons.write(new TextEncoder().encode(data));
    }
  }
}
```

## Error Handling

Handle Rerror gracefully:

```typescript
function handleResponse(msg: RMessage): void {
  if (msg.type === RERROR) {
    console.error('9P error:', msg.ename);
    // Display to user, possibly reconnect
    return;
  }
  // Handle normal response
}
```

## Read Pipelining

Keep reads in flight for responsiveness:

```typescript
class ConsReader {
  private fid: number;
  private pending = 0;
  private maxPending = 2;
  
  start(): void {
    this.issueReads();
  }
  
  private issueReads(): void {
    while (this.pending < this.maxPending) {
      this.pending++;
      this.client.read(this.fid, 0n, 8192, (msg) => {
        this.pending--;
        if (msg.type === RREAD && msg.count > 0) {
          this.terminal.write(msg.data);
        }
        this.issueReads();
      });
    }
  }
}
```

## Testing Without 9front

For initial TypeScript development, a mock server:

```typescript
class Mock9PServer {
  private output = "Welcome to Enoch\n% ";
  
  handle(msg: TMessage): RMessage {
    switch (msg.type) {
      case TVERSION:
        return { type: RVERSION, tag: msg.tag, msize: 8192, version: "9P2000" };
      case TATTACH:
        return { type: RATTACH, tag: msg.tag, qid: mockQid() };
      case TWALK:
        return { type: RWALK, tag: msg.tag, qids: msg.wnames.map(() => mockQid()) };
      case TOPEN:
        return { type: ROPEN, tag: msg.tag, qid: mockQid(), iounit: 0 };
      case TREAD:
        const data = new TextEncoder().encode(this.output);
        this.output = '';
        return { type: RREAD, tag: msg.tag, count: data.length, data };
      case TWRITE:
        this.output = `echo: ${new TextDecoder().decode(msg.data)}\n% `;
        return { type: RWRITE, tag: msg.tag, count: msg.count };
      default:
        return { type: RERROR, tag: msg.tag, ename: "not implemented" };
    }
  }
}
```

## Deliverables

### TypeScript Files

| File | Purpose |
|------|---------|
| `transport.ts` | WebSocket connection management |
| `9p/messages.ts` | Message type definitions and encode/decode |
| `9p/client.ts` | 9P client with tag/fid management |
| `devices/cons.ts` | /dev/cons abstraction |
| `ui/terminal.ts` | Terminal display and input |
| `main.ts` | Application entry point |

### Plan 9 Files

| File | Purpose |
|------|---------|
| `enoch.c` | WebSocket trampoline |
| `mkfile` | Build instructions |

### HTML

| File | Purpose |
|------|---------|
| `index.html` | Single page application shell |

## Success Criteria

Phase 1 is complete when:

1. Browser connects via WebSocket
2. 9P version/attach/walk/open succeeds
3. Output from 9front appears in terminal
4. Keystrokes are sent and echoed
5. Basic commands (ls, cat, echo) work
6. Connection errors are handled gracefully
