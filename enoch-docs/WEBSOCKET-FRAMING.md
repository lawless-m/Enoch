# WebSocket Framing

The trampoline bridges WebSocket to TCP 9P. This document covers the WebSocket protocol the trampoline must implement.

## Overview

WebSocket starts as an HTTP request, upgrades to a persistent bidirectional connection. The trampoline needs to:

1. Accept HTTP upgrade request
2. Complete WebSocket handshake
3. Frame/unframe WebSocket messages
4. Shuttle bytes to/from the 9P server

## HTTP Upgrade Handshake

### Client Request

```http
GET /enoch HTTP/1.1
Host: 9front.local:8080
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

### Server Response

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

### Sec-WebSocket-Accept Calculation

```
accept = base64(sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
```

Where `key` is the client's `Sec-WebSocket-Key` value.

**Plan 9 implementation:**

```c
#include <libsec.h>

char*
wsaccept(char *key)
{
    char buf[128];
    uchar digest[SHA1dlen];
    
    snprint(buf, sizeof buf, "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key);
    sha1((uchar*)buf, strlen(buf), digest, nil);
    return enc64(digest, SHA1dlen);  /* caller must free */
}
```

## WebSocket Frame Format

```
      0                   1                   2                   3
      0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
     +-+-+-+-+-------+-+-------------+-------------------------------+
     |F|R|R|R| opcode|M| Payload len |    Extended payload length    |
     |I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
     |N|V|V|V|       |S|             |   (if payload len==126/127)   |
     | |1|2|3|       |K|             |                               |
     +-+-+-+-+-------+-+-------------+ - - - - - - - - - - - - - - - +
     |     Extended payload length continued, if payload len == 127  |
     + - - - - - - - - - - - - - - - +-------------------------------+
     |                               |Masking-key, if MASK set to 1  |
     +-------------------------------+-------------------------------+
     | Masking-key (continued)       |          Payload Data         |
     +-------------------------------- - - - - - - - - - - - - - - - +
     :                     Payload Data continued ...                :
     + - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
     |                     Payload Data continued ...                |
     +---------------------------------------------------------------+
```

### Header Fields

| Field | Bits | Description |
|-------|------|-------------|
| FIN | 1 | Final fragment (always 1 for us) |
| RSV1-3 | 3 | Reserved, must be 0 |
| opcode | 4 | Frame type |
| MASK | 1 | Payload is masked (client→server only) |
| Payload len | 7 | Length or length indicator |

### Opcodes

| Value | Name | Description |
|-------|------|-------------|
| 0x0 | Continuation | Fragment continuation |
| 0x1 | Text | UTF-8 text data |
| 0x2 | Binary | Binary data (use this for 9P) |
| 0x8 | Close | Connection close |
| 0x9 | Ping | Ping |
| 0xA | Pong | Pong |

### Payload Length Encoding

| Length value | Meaning |
|--------------|---------|
| 0-125 | Actual length |
| 126 | Following 2 bytes are length (big-endian u16) |
| 127 | Following 8 bytes are length (big-endian u64) |

### Masking

Client-to-server frames MUST be masked. Server-to-client frames MUST NOT be masked.

Masking XORs each payload byte with the mask key:

```c
unmasked[i] = masked[i] ^ mask[i % 4]
```

The 4-byte mask key immediately precedes the payload in masked frames.

## Frame Parsing (Server Side)

```c
typedef struct WsFrame WsFrame;
struct WsFrame {
    int     fin;
    int     opcode;
    int     masked;
    uvlong  len;
    uchar   mask[4];
    uchar   *data;
};

int
wsread(int fd, WsFrame *f)
{
    uchar hdr[2];
    uchar ext[8];
    int n;
    
    if(readn(fd, hdr, 2) != 2)
        return -1;
    
    f->fin = (hdr[0] >> 7) & 1;
    f->opcode = hdr[0] & 0x0F;
    f->masked = (hdr[1] >> 7) & 1;
    f->len = hdr[1] & 0x7F;
    
    if(f->len == 126){
        if(readn(fd, ext, 2) != 2)
            return -1;
        f->len = (ext[0] << 8) | ext[1];
    } else if(f->len == 127){
        if(readn(fd, ext, 8) != 8)
            return -1;
        f->len = 0;
        for(n = 0; n < 8; n++)
            f->len = (f->len << 8) | ext[n];
    }
    
    if(f->masked){
        if(readn(fd, f->mask, 4) != 4)
            return -1;
    }
    
    f->data = malloc(f->len);
    if(f->data == nil)
        return -1;
    
    if(readn(fd, f->data, f->len) != f->len){
        free(f->data);
        return -1;
    }
    
    if(f->masked){
        for(n = 0; n < f->len; n++)
            f->data[n] ^= f->mask[n % 4];
    }
    
    return 0;
}
```

## Frame Writing (Server Side)

Server frames are NOT masked:

```c
int
wswrite(int fd, int opcode, uchar *data, uvlong len)
{
    uchar hdr[10];
    int hlen;
    
    hdr[0] = 0x80 | opcode;  /* FIN + opcode */
    
    if(len < 126){
        hdr[1] = len;
        hlen = 2;
    } else if(len < 65536){
        hdr[1] = 126;
        hdr[2] = (len >> 8) & 0xFF;
        hdr[3] = len & 0xFF;
        hlen = 4;
    } else {
        hdr[1] = 127;
        hdr[2] = (len >> 56) & 0xFF;
        hdr[3] = (len >> 48) & 0xFF;
        hdr[4] = (len >> 40) & 0xFF;
        hdr[5] = (len >> 32) & 0xFF;
        hdr[6] = (len >> 24) & 0xFF;
        hdr[7] = (len >> 16) & 0xFF;
        hdr[8] = (len >> 8) & 0xFF;
        hdr[9] = len & 0xFF;
        hlen = 10;
    }
    
    if(write(fd, hdr, hlen) != hlen)
        return -1;
    if(write(fd, data, len) != len)
        return -1;
    
    return 0;
}
```

## Control Frames

### Ping/Pong

The trampoline must respond to Ping (0x9) with Pong (0xA), echoing the payload:

```c
if(f.opcode == 0x9){  /* Ping */
    wswrite(fd, 0xA, f.data, f.len);  /* Pong */
}
```

### Close

On receiving Close (0x8), send a Close response and terminate:

```c
if(f.opcode == 0x8){  /* Close */
    wswrite(fd, 0x8, f.data, f.len);
    close(fd);
    return;
}
```

## Complete Message Flow

```
Browser                          Trampoline                     9P Server
───────                          ──────────                     ─────────
   │                                 │                              │
   │─── GET /cpu HTTP/1.1 ─────────▶│                              │
   │    Upgrade: websocket           │                              │
   │                                 │ (route lookup: /cpu)         │
   │◀── 101 Switching Protocols ────│                              │
   │                                 │                              │
   │                                 │─── TCP connect ────────────▶│
   │                                 │    (to route backend)        │
   │                                 │                              │
   │─── WS Binary [9P Tversion] ───▶│                              │
   │                                 │─── 9P Tversion ───────────▶│
   │                                 │◀── 9P Rversion ────────────│
   │◀── WS Binary [9P Rversion] ────│                              │
   │                                 │                              │
   │─── WS Binary [9P Tattach] ────▶│                              │
   │                                 │─── 9P Tattach ────────────▶│
   │                                 │◀── 9P Rattach ─────────────│
   │◀── WS Binary [9P Rattach] ─────│                              │
   │                                 │                              │
   ...                               ...                            ...
   │                                 │                              │
   │─── WS Close ──────────────────▶│                              │
   │◀── WS Close ───────────────────│─── TCP close ──────────────▶│
   │                                 │                              │
```

## TypeScript Client Side

The browser's WebSocket API handles framing automatically:

```typescript
const ws = new WebSocket('wss://9front.local:8080/cpu');
ws.binaryType = 'arraybuffer';

ws.onopen = () => {
  // Send 9P Tversion
  const msg = encodeTversion(0xFFFF, 8192);
  ws.send(msg);
};

ws.onmessage = (event) => {
  const data = new Uint8Array(event.data);
  // Parse 9P message
  const msg = decode9P(data);
  handleResponse(msg);
};

ws.onclose = (event) => {
  console.log('Connection closed:', event.code, event.reason);
};

ws.onerror = (event) => {
  console.error('WebSocket error:', event);
};
```

## URL Scheme

| Scheme | Port | Description |
|--------|------|-------------|
| ws:// | 80 | Unencrypted (dev only) |
| wss:// | 443 | TLS encrypted (production) |

Custom ports work: `wss://9front.local:8443/enoch`

## Security Notes

1. **Always use wss:// in production** - ws:// exposes all traffic including auth
2. **Validate Origin header** - The trampoline can check the Origin to restrict access
3. **No credential caching** - Each connection authenticates fresh
