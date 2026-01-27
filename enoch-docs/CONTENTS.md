# Enoch Documentation

A browser-based CPU client for 9front, implementing /dev/cons, /dev/draw, and /dev/mouse over WebSocket-tunnelled 9P.

## Contents

| Document | Description |
|----------|-------------|
| [OVERVIEW.md](OVERVIEW.md) | **Start here.** Architecture, goals, phased approach |
| [9P-PROTOCOL.md](9P-PROTOCOL.md) | 9P2000 wire format and message types |
| [WEBSOCKET-FRAMING.md](WEBSOCKET-FRAMING.md) | WebSocket protocol for the trampoline |
| [PHASE1-CONSOLE.md](PHASE1-CONSOLE.md) | Phase 1: Text terminal implementation |
| [PHASE2-AUTH.md](PHASE2-AUTH.md) | Phase 2: p9sk1/dp9ik authentication via Rust WASM |
| [PHASE3-DRAW.md](PHASE3-DRAW.md) | Phase 3: /dev/draw and canvas rendering |
| [TYPESCRIPT-API.md](TYPESCRIPT-API.md) | TypeScript client architecture and interfaces |
| [TRAMPOLINE.md](TRAMPOLINE.md) | Plan 9 C WebSocket server |

## Project Structure

```
enoch/
├── client/                 # TypeScript browser client
│   ├── src/
│   │   ├── 9p/            # 9P protocol implementation
│   │   │   ├── messages.ts
│   │   │   ├── client.ts
│   │   │   └── fid.ts
│   │   ├── devices/       # Device implementations
│   │   │   ├── cons.ts
│   │   │   ├── draw.ts
│   │   │   └── mouse.ts
│   │   ├── auth/          # WASM auth bindings
│   │   │   └── auth.ts
│   │   ├── ui/            # UI components
│   │   │   ├── terminal.ts
│   │   │   └── canvas.ts
│   │   ├── transport.ts   # WebSocket management
│   │   └── main.ts
│   ├── index.html
│   ├── package.json
│   └── tsconfig.json
│
├── auth-wasm/             # Rust WASM auth module
│   ├── src/
│   │   └── lib.rs
│   ├── Cargo.toml
│   └── build.sh
│
└── trampoline/            # Plan 9 C server
    ├── enoch.c
    └── mkfile
```

## Phased Implementation

### Phase 1: Console (No Auth)
Get bytes flowing. Text terminal over unauthenticated 9P.

### Phase 2: Authentication
Add p9sk1/dp9ik support via Rust WASM.

### Phase 3: Graphics
Implement /dev/draw, /dev/mouse for full graphical client.

## Dependencies

**Client (TypeScript):**
- Modern browser with WebSocket and Canvas support
- TypeScript 5.x
- No runtime dependencies (vanilla TS)

**Auth (Rust WASM):**
- Rust toolchain with `wasm32-unknown-unknown` target
- wasm-bindgen

**Trampoline (Plan 9):**
- 9front
- No external dependencies
