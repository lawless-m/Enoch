# Enoch Overview

Enoch is a browser-based CPU client for 9front, analogous to drawterm but running entirely in the browser. It provides access to a 9front system via /dev/cons (terminal), /dev/draw (graphics), and /dev/mouse (pointer input), tunnelled over WebSocket.

## Goals

1. **Zero install**: Run directly in any modern browser
2. **Full CPU client**: Not just a terminal - full graphical access
3. **Secure auth**: Proper p9sk1/dp9ik authentication, not security theatre
4. **Minimal server-side**: The trampoline should be trivial Plan 9 C

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │                    TypeScript                          │ │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────┐ │ │
│  │  │ /dev/   │  │ /dev/   │  │ /dev/   │  │ 9P       │ │ │
│  │  │ cons    │  │ draw    │  │ mouse   │  │ Client   │ │ │
│  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬─────┘ │ │
│  │       │            │            │             │        │ │
│  │       └────────────┴────────────┴─────────────┘        │ │
│  │                          │                              │ │
│  │  ┌───────────────────────┴───────────────────────────┐ │ │
│  │  │                   Transport                        │ │ │
│  │  │              (WebSocket Manager)                   │ │ │
│  │  └───────────────────────┬───────────────────────────┘ │ │
│  └──────────────────────────┼────────────────────────────┘ │
│                             │                               │
│  ┌──────────────────────────┴────────────────────────────┐ │
│  │                  Rust WASM (auth only)                 │ │
│  │           p9sk1 / dp9ik / Plan 9 DES                   │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────┬───────────────────────────┘
                                  │ wss://
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│                        9front                               │
│  ┌───────────────────────────────────────────────────────┐ │
│  │                    Trampoline                          │ │
│  │              (WebSocket ↔ 9P bridge)                   │ │
│  │                     enoch.c                            │ │
│  └───────────────────────┬───────────────────────────────┘ │
│                          │ 9P/TCP                          │
│                          ▼                                  │
│  ┌───────────────────────────────────────────────────────┐ │
│  │                   CPU Server                           │ │
│  │              (or exportfs for testing)                 │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Why WebSocket?

Browsers cannot make raw TCP connections. WebSocket is:
- Supported in all browsers
- Works through proxies and firewalls (HTTP upgrade)
- Bidirectional, low overhead once established
- Can be secured with TLS (wss://)

The trampoline simply bridges WebSocket frames to a TCP 9P connection.

## Why WASM for Auth?

Plan 9's authentication has quirks:
- **Plan 9 DES** has non-standard bit ordering
- **p9sk1/dp9ik** are Plan 9-specific protocols
- **JavaScript timing attacks** are a concern for crypto

We already have working Rust implementations of p9sk1 and dp9ik. Compiling to WASM:
- Reuses tested code
- Provides better timing characteristics than JS
- Keeps the crypto boundary small and auditable

The WASM module exposes only the functions TypeScript needs:
- `auth_init()` - Start authentication
- `auth_respond()` - Handle challenge/response
- `derive_key()` - Derive session key
- `encrypt()` / `decrypt()` - Message encryption (if needed)

## Why TypeScript?

The bulk of the client is protocol handling and rendering:
- 9P message parsing is just DataView operations on ArrayBuffers
- /dev/draw rendering maps directly to Canvas API
- Everything is debuggable in browser dev tools
- No framework dependencies, just vanilla TypeScript

## Data Flow

### Console (Phase 1)

```
Keystroke → cons.ts → 9P Twrite → WebSocket → trampoline → /dev/cons
                                                               │
Screen    ← cons.ts ← 9P Rread  ← WebSocket ← trampoline ← ───┘
```

### Graphics (Phase 3)

```
Mouse move → mouse.ts → 9P Twrite → WebSocket → trampoline → /dev/mouse
                                                                  │
Draw cmd   ← draw.ts  ← 9P Rread  ← WebSocket ← trampoline ← /dev/draw
    │
    ▼
Canvas API
```

## Security Considerations

1. **TLS Required**: Production deployments should use wss:// exclusively
2. **Auth in WASM**: Crypto operations happen in compiled WASM, not interpretable JS
3. **Trampoline Trust**: The trampoline sees plaintext 9P - run it on the 9front box itself
4. **No Credential Storage**: Browser doesn't store keys; auth happens fresh each connection

## Limitations

- **Single connection**: One Enoch tab = one CPU session
- **No clipboard**: No direct clipboard integration (could be added via /dev/snarf)
- **Performance**: Canvas rendering won't match native drawterm for heavy graphics
- **Browser quirks**: Keyboard handling varies across browsers/platforms
