# 9P2000 Protocol Reference

This document covers the 9P2000 wire format as needed for Enoch. For the complete specification, see the Plan 9 manual.

## Wire Format

All 9P messages have the same structure:

```
┌──────────┬──────┬──────┬─────────────────┐
│ size[4]  │ type │ tag  │ payload...      │
│ (LE u32) │ [1]  │ [2]  │ (variable)      │
└──────────┴──────┴──────┴─────────────────┘
```

- **size**: Total message length including the size field itself (little-endian u32)
- **type**: Message type (u8)
- **tag**: Transaction identifier (little-endian u16), chosen by client
- **payload**: Type-specific data

All integers are little-endian. Strings are length-prefixed with a u16 length, not null-terminated.

## String Encoding

```
┌───────────┬─────────────┐
│ len[2]    │ data[len]   │
│ (LE u16)  │ (UTF-8)     │
└───────────┴─────────────┘
```

## Message Types

### T-messages (Client → Server)

| Type | Value | Description |
|------|-------|-------------|
| Tversion | 100 | Negotiate protocol version |
| Tauth | 102 | Authenticate |
| Tattach | 104 | Attach to file tree |
| Twalk | 110 | Navigate path |
| Topen | 112 | Open file |
| Tcreate | 114 | Create file |
| Tread | 116 | Read from file |
| Twrite | 118 | Write to file |
| Tclunk | 120 | Release fid |
| Tremove | 122 | Remove file |
| Tstat | 124 | Get file info |
| Twstat | 126 | Set file info |
| Tflush | 108 | Cancel request |

### R-messages (Server → Client)

Each T-message has a corresponding R-message with value = T-value + 1.

| Type | Value | Description |
|------|-------|-------------|
| Rversion | 101 | Version response |
| Rauth | 103 | Auth response |
| Rattach | 105 | Attach response |
| Rwalk | 111 | Walk response |
| Ropen | 113 | Open response |
| Rcreate | 115 | Create response |
| Rread | 117 | Read response |
| Rwrite | 119 | Write response |
| Rclunk | 121 | Clunk response |
| Rremove | 123 | Remove response |
| Rstat | 125 | Stat response |
| Rwstat | 127 | Wstat response |
| Rflush | 109 | Flush response |
| Rerror | 107 | Error response |

## Message Formats

### Tversion / Rversion

Negotiate protocol version and maximum message size.

**Tversion:**
```
size[4] Tversion tag[2] msize[4] version[s]
```

**Rversion:**
```
size[4] Rversion tag[2] msize[4] version[s]
```

- **msize**: Maximum message size client/server will handle
- **version**: Protocol version string, always `"9P2000"` for base protocol

Example:
```
Client: Tversion msize=65536 version="9P2000"
Server: Rversion msize=65536 version="9P2000"
```

### Tattach / Rattach

Attach to the file tree root.

**Tattach:**
```
size[4] Tattach tag[2] fid[4] afid[4] uname[s] aname[s]
```

**Rattach:**
```
size[4] Rattach tag[2] qid[13]
```

- **fid**: Client-chosen file identifier for the root
- **afid**: Auth fid (NOFID = 0xFFFFFFFF if no auth)
- **uname**: User name
- **aname**: File tree name (often empty)
- **qid**: Unique file identifier (see QID section)

### Twalk / Rwalk

Navigate from one fid to another through path elements.

**Twalk:**
```
size[4] Twalk tag[2] fid[4] newfid[4] nwname[2] nwname*(wname[s])
```

**Rwalk:**
```
size[4] Rwalk tag[2] nwqid[2] nwqid*(qid[13])
```

- **fid**: Starting point
- **newfid**: New fid for destination (can equal fid to reuse)
- **nwname**: Number of path elements
- **wname[]**: Path elements (e.g., "dev", "cons")
- **nwqid**: Number of qids returned (may be less than nwname on partial walk)
- **qid[]**: QID for each successfully walked element

Example - walk from root to /dev/cons:
```
Client: Twalk fid=0 newfid=1 nwname=2 ["dev", "cons"]
Server: Rwalk nwqid=2 [qid1, qid2]
```

### Topen / Ropen

Open a file for I/O.

**Topen:**
```
size[4] Topen tag[2] fid[4] mode[1]
```

**Ropen:**
```
size[4] Ropen tag[2] qid[13] iounit[4]
```

- **mode**: Open mode flags
- **iounit**: Maximum bytes per read/write (0 = use msize - 24)

**Mode flags:**
| Value | Name | Description |
|-------|------|-------------|
| 0 | OREAD | Read only |
| 1 | OWRITE | Write only |
| 2 | ORDWR | Read and write |
| 3 | OEXEC | Execute |
| 0x10 | OTRUNC | Truncate |
| 0x40 | ORCLOSE | Remove on close |

### Tread / Rread

Read data from an open file.

**Tread:**
```
size[4] Tread tag[2] fid[4] offset[8] count[4]
```

**Rread:**
```
size[4] Rread tag[2] count[4] data[count]
```

- **offset**: Byte offset in file (little-endian u64)
- **count**: Number of bytes to read / bytes returned
- **data**: File content

### Twrite / Rwrite

Write data to an open file.

**Twrite:**
```
size[4] Twrite tag[2] fid[4] offset[8] count[4] data[count]
```

**Rwrite:**
```
size[4] Rwrite tag[2] count[4]
```

- **offset**: Byte offset in file
- **count**: Number of bytes to write / bytes written
- **data**: Data to write

### Tclunk / Rclunk

Release a fid.

**Tclunk:**
```
size[4] Tclunk tag[2] fid[4]
```

**Rclunk:**
```
size[4] Rclunk tag[2]
```

### Rerror

Error response (can replace any R-message).

**Rerror:**
```
size[4] Rerror tag[2] ename[s]
```

- **ename**: Error message string

## QID Structure

A QID uniquely identifies a file on the server:

```
┌──────────┬─────────┬──────────┐
│ type[1]  │ vers[4] │ path[8]  │
└──────────┴─────────┴──────────┘
```

- **type**: File type flags
- **vers**: Version number (changes on file modification)
- **path**: Unique file identifier

**QID type flags:**
| Value | Name | Description |
|-------|------|-------------|
| 0x80 | QTDIR | Directory |
| 0x40 | QTAPPEND | Append-only |
| 0x20 | QTEXCL | Exclusive use |
| 0x08 | QTAUTH | Authentication file |
| 0x04 | QTTMP | Temporary |
| 0x00 | QTFILE | Regular file |

## Console Session Example

Minimal session to open /dev/cons:

```
→ Tversion tag=0xFFFF msize=8192 version="9P2000"
← Rversion tag=0xFFFF msize=8192 version="9P2000"

→ Tattach tag=0 fid=0 afid=NOFID uname="glenda" aname=""
← Rattach tag=0 qid={type=0x80, vers=0, path=1}

→ Twalk tag=1 fid=0 newfid=1 nwname=2 ["dev", "cons"]
← Rwalk tag=1 nwqid=2 [qid1, qid2]

→ Topen tag=2 fid=1 mode=ORDWR
← Ropen tag=2 qid={...} iounit=0

→ Tread tag=3 fid=1 offset=0 count=8192
← Rread tag=3 count=5 data="hello"

→ Twrite tag=4 fid=1 offset=0 count=3 data="ls\n"
← Rwrite tag=4 count=3

→ Tclunk tag=5 fid=1
← Rclunk tag=5
```

## Tags

- Tags are chosen by the client (u16)
- Each outstanding request needs a unique tag
- Server echoes the tag in the response
- Tag 0xFFFF (NOTAG) is reserved for Tversion

## Fids

- Fids are chosen by the client (u32)
- Each open file/directory needs a unique fid
- Fid 0xFFFFFFFF (NOFID) means "no fid" (used for afid when no auth)
- Fids are released with Tclunk

## TypeScript Encoding Example

```typescript
const TVERSION = 100;
const TATTACH = 104;
const TWALK = 110;
const TOPEN = 112;
const TREAD = 116;
const TWRITE = 118;
const TCLUNK = 120;

function encodeString(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  const buf = new Uint8Array(2 + encoded.length);
  const view = new DataView(buf.buffer);
  view.setUint16(0, encoded.length, true);
  buf.set(encoded, 2);
  return buf;
}

function encodeTversion(tag: number, msize: number): Uint8Array {
  const version = encodeString("9P2000");
  const size = 4 + 1 + 2 + 4 + version.length;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  
  view.setUint32(0, size, true);        // size
  view.setUint8(4, TVERSION);           // type
  view.setUint16(5, tag, true);         // tag
  view.setUint32(7, msize, true);       // msize
  buf.set(version, 11);                 // version
  
  return buf;
}
```
