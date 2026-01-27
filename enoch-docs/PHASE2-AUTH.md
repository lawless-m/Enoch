# Phase 2: Authentication

Add proper p9sk1/dp9ik authentication using Rust compiled to WASM.

## Goal

Replace `afid=NOFID` with real authentication so Enoch can connect to production CPU servers.

## Why Rust WASM?

1. **Plan 9 DES is non-standard** - bit ordering differs from standard DES
2. **Existing implementation** - we have working Rust p9sk1/dp9ik code
3. **Timing safety** - WASM provides better timing characteristics than JS
4. **Small surface** - only auth functions exposed, not the whole protocol

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                              │
│  ┌───────────────────────────────────────────────────────┐ │
│  │                    TypeScript                          │ │
│  │                                                        │ │
│  │   1. User enters credentials                           │ │
│  │   2. Tattach with afid                                │ │
│  │   3. Walk to afid, open it                            │ │
│  │   4. Read challenge from afid                          │ │
│  │            │                                           │ │
│  │            ▼                                           │ │
│  │   ┌──────────────────────────────────────────────┐    │ │
│  │   │              auth.ts (JS glue)               │    │ │
│  │   │                                              │    │ │
│  │   │   const response = await auth.respond(       │    │ │
│  │   │     challenge, key, user, hostid             │    │ │
│  │   │   );                                         │    │ │
│  │   │                    │                         │    │ │
│  │   └────────────────────┼─────────────────────────┘    │ │
│  │                        │                               │ │
│  └────────────────────────┼───────────────────────────────┘ │
│                           ▼                                 │
│  ┌───────────────────────────────────────────────────────┐ │
│  │                 auth.wasm (Rust)                       │ │
│  │                                                        │ │
│  │   - Plan 9 DES (non-standard bit order)               │ │
│  │   - p9sk1 protocol                                     │ │
│  │   - dp9ik protocol                                     │ │
│  │   - Key derivation                                     │ │
│  │                                                        │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## p9sk1 Protocol Flow

```
Client                                 Server
──────                                 ──────
         ──── Tauth(afid, uname) ────▶
         ◀─── Rauth(qid) ────────────

         ──── Tread(afid) ──────────▶
         ◀─── Rread(CHc) ────────────   Server challenge (8 bytes)

  Generate client challenge CHc'
  Compute ticket request

         ──── Twrite(afid, ticketreq) ─▶
         ◀─── Rread(ticket + auth) ────  From auth server

  Decrypt ticket with user key
  Verify server authenticator
  Create client authenticator

         ──── Twrite(afid, client_auth) ▶
         ◀─── Rread(ok) ────────────────

  Now afid is authenticated
  
         ──── Tattach(fid, afid, ...) ─▶
         ◀─── Rattach(qid) ─────────────
```

## dp9ik Protocol Flow

dp9ik uses PAK (Password Authenticated Key exchange) for stronger security:

```
Client                                 Server
──────                                 ──────
         ──── Tauth(afid, uname) ────▶
         ◀─── Rauth(qid) ────────────

         ──── Tread(afid) ──────────▶
         ◀─── Rread(start_msg) ───────  Protocol indicator + params

  PAK exchange begins
  
         ──── Twrite(afid, Y) ────────▶  Client PAK value
         ◀─── Rread(X) ───────────────   Server PAK value

  Derive shared secret
  Compute session key
  
         ──── Twrite(afid, confirm) ──▶
         ◀─── Rread(confirm) ─────────

  Mutual authentication complete
  
         ──── Tattach(fid, afid, ...) ─▶
         ◀─── Rattach(qid) ─────────────
```

## WASM Interface

### Rust Side (lib.rs)

```rust
use wasm_bindgen::prelude::*;

/// Initialize auth state for p9sk1
#[wasm_bindgen]
pub fn p9sk1_init(user: &str, key: &[u8]) -> Result<AuthState, JsValue> {
    // ...
}

/// Process server challenge, return response
#[wasm_bindgen]
pub fn p9sk1_respond(
    state: &mut AuthState,
    challenge: &[u8],
) -> Result<Vec<u8>, JsValue> {
    // ...
}

/// Verify server's authenticator
#[wasm_bindgen]
pub fn p9sk1_verify(
    state: &AuthState,
    authenticator: &[u8],
) -> Result<bool, JsValue> {
    // ...
}

/// Initialize auth state for dp9ik
#[wasm_bindgen]
pub fn dp9ik_init(user: &str, password: &str) -> Result<AuthState, JsValue> {
    // ...
}

/// Process dp9ik message, return response
#[wasm_bindgen]
pub fn dp9ik_respond(
    state: &mut AuthState,
    msg: &[u8],
) -> Result<Vec<u8>, JsValue> {
    // ...
}

/// Get session key after successful auth
#[wasm_bindgen]
pub fn get_session_key(state: &AuthState) -> Result<Vec<u8>, JsValue> {
    // ...
}
```

### TypeScript Side (auth.ts)

```typescript
import init, { 
  p9sk1_init, 
  p9sk1_respond, 
  p9sk1_verify,
  dp9ik_init,
  dp9ik_respond,
  get_session_key
} from './auth.wasm';

export type AuthProtocol = 'p9sk1' | 'dp9ik';

export interface AuthConfig {
  protocol: AuthProtocol;
  user: string;
  password?: string;  // For dp9ik
  key?: Uint8Array;   // For p9sk1 (derived from password)
  hostid?: string;
}

export class Authenticator {
  private state: any;
  private protocol: AuthProtocol;
  
  static async create(config: AuthConfig): Promise<Authenticator> {
    await init();  // Load WASM module
    
    const auth = new Authenticator();
    auth.protocol = config.protocol;
    
    if (config.protocol === 'p9sk1') {
      const key = config.key ?? deriveKey(config.password!);
      auth.state = p9sk1_init(config.user, key);
    } else {
      auth.state = dp9ik_init(config.user, config.password!);
    }
    
    return auth;
  }
  
  respond(challenge: Uint8Array): Uint8Array {
    if (this.protocol === 'p9sk1') {
      return p9sk1_respond(this.state, challenge);
    } else {
      return dp9ik_respond(this.state, challenge);
    }
  }
  
  verify(authenticator: Uint8Array): boolean {
    if (this.protocol === 'p9sk1') {
      return p9sk1_verify(this.state, authenticator);
    }
    return true;  // dp9ik verifies during exchange
  }
  
  sessionKey(): Uint8Array {
    return get_session_key(this.state);
  }
}

function deriveKey(password: string): Uint8Array {
  // Plan 9 key derivation from password
  // This might also be in WASM
}
```

## 9P Client Changes

### Auth Fid Management

```typescript
class Client9P {
  private authFid: number | null = null;
  
  async authenticate(config: AuthConfig): Promise<void> {
    // Allocate auth fid
    this.authFid = this.fidPool.alloc();
    
    // Tauth
    const rauth = await this.tauth(this.authFid, config.user, '');
    
    // Create authenticator
    const auth = await Authenticator.create(config);
    
    // Read challenge
    const challenge = await this.read(this.authFid, 0n, 128);
    
    // Compute response
    const response = auth.respond(challenge);
    
    // Write response
    await this.write(this.authFid, 0n, response);
    
    // Read server authenticator (p9sk1) or confirmation (dp9ik)
    const serverAuth = await this.read(this.authFid, 0n, 128);
    
    if (!auth.verify(serverAuth)) {
      throw new Error('Server authentication failed');
    }
    
    // Auth fid is now ready for attach
  }
  
  async attach(user: string, aname: string): Promise<number> {
    const fid = this.fidPool.alloc();
    const afid = this.authFid ?? NOFID;
    
    await this.tattach(fid, afid, user, aname);
    
    return fid;
  }
}
```

## Cargo.toml

```toml
[package]
name = "enoch-auth"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"

[profile.release]
opt-level = "s"      # Optimize for size
lto = true           # Link-time optimization
```

## Build Process

```bash
#!/bin/bash
# build.sh

# Ensure target is installed
rustup target add wasm32-unknown-unknown

# Build WASM
cargo build --target wasm32-unknown-unknown --release

# Generate JS bindings
wasm-bindgen \
  --target web \
  --out-dir ../client/src/auth \
  target/wasm32-unknown-unknown/release/enoch_auth.wasm

# Optional: optimize size
wasm-opt -Os -o ../client/src/auth/auth.wasm ../client/src/auth/auth_bg.wasm
```

## Credential Input

Simple password prompt (no storage):

```typescript
async function getCredentials(): Promise<AuthConfig> {
  const user = prompt('Username:');
  const password = prompt('Password:');
  
  if (!user || !password) {
    throw new Error('Credentials required');
  }
  
  return {
    protocol: 'dp9ik',  // Or detect from server
    user,
    password,
  };
}
```

## Protocol Detection

The server indicates which auth protocol to use. Read from auth fid:

```typescript
async function detectProtocol(authFid: number): Promise<AuthProtocol> {
  const data = await this.read(authFid, 0n, 128);
  
  // dp9ik starts with specific bytes
  if (data[0] === /* dp9ik indicator */) {
    return 'dp9ik';
  }
  
  // Otherwise assume p9sk1
  return 'p9sk1';
}
```

## Session Key Usage

After authentication, the session key can be used for encrypted 9P messages if the server supports it. For now, we rely on TLS (wss://) for transport security.

## Error Handling

```typescript
class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: 'INVALID_CREDENTIALS' | 'PROTOCOL_ERROR' | 'TIMEOUT'
  ) {
    super(message);
  }
}

async function authenticate(config: AuthConfig): Promise<void> {
  try {
    await this.client.authenticate(config);
  } catch (e) {
    if (e instanceof Error && e.message.includes('permission denied')) {
      throw new AuthError('Invalid username or password', 'INVALID_CREDENTIALS');
    }
    throw new AuthError('Authentication failed', 'PROTOCOL_ERROR');
  }
}
```

## Testing

### With Auth Server

Run a local factotum/authsrv for testing:

```sh
# On 9front
auth/keyfs
auth/cron
```

### Mock Auth (Development)

For TypeScript development without 9front:

```typescript
class MockAuthServer {
  private validUsers = new Map([
    ['glenda', 'password123'],
  ]);
  
  handleAuth(user: string, response: Uint8Array): Uint8Array {
    // Simplified - real impl would verify crypto
    if (this.validUsers.has(user)) {
      return new Uint8Array([/* success indicator */]);
    }
    throw new Error('permission denied');
  }
}
```

## Deliverables

### Rust Files

| File | Purpose |
|------|---------|
| `src/lib.rs` | WASM entry point, bindings |
| `src/des.rs` | Plan 9 DES implementation |
| `src/p9sk1.rs` | p9sk1 protocol |
| `src/dp9ik.rs` | dp9ik protocol |
| `src/pak.rs` | PAK key exchange |
| `Cargo.toml` | Dependencies |
| `build.sh` | Build script |

### TypeScript Files

| File | Purpose |
|------|---------|
| `auth/auth.ts` | WASM bindings and Authenticator class |
| `auth/credentials.ts` | Credential input UI |

## Success Criteria

Phase 2 is complete when:

1. WASM module builds and loads in browser
2. p9sk1 authentication works with real auth server
3. dp9ik authentication works with real auth server
4. Invalid credentials produce clear error message
5. Authenticated attach succeeds
6. Session continues to work (Phase 1 functionality preserved)
