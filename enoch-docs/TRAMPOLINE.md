# Trampoline (Plan 9 C)

The trampoline is a WebSocket server running on 9front that bridges browser connections to the CPU/exportfs infrastructure.

## Overview

```
Browser ──wss://──▶ Trampoline ──9P──▶ exportfs/cpu
```

The trampoline:
1. Accepts incoming HTTP connections
2. Upgrades WebSocket connections
3. Forks a handler for each connection
4. Bridges WebSocket frames to/from 9P TCP

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        enoch.c                              │
│                                                             │
│   main()                                                    │
│     │                                                       │
│     ▼                                                       │
│   listen(port)                                              │
│     │                                                       │
│     └──▶ accept() ──▶ rfork() ──▶ handler()                │
│              │                        │                     │
│              │                        ▼                     │
│              │                  httpupgrade()               │
│              │                        │                     │
│              │                        ▼                     │
│              │                  dial(exportfs)              │
│              │                        │                     │
│              │                        ▼                     │
│              │              ┌─────────────────┐             │
│              │              │   bridge loop   │             │
│              │              │  ws ←→ 9p      │             │
│              │              └─────────────────┘             │
│              │                                              │
│              └──▶ accept() ──▶ ... (next connection)       │
└─────────────────────────────────────────────────────────────┘
```

## Source Code Structure

### enoch.c

```c
#include <u.h>
#include <libc.h>
#include <bio.h>
#include <libsec.h>

enum {
    MaxHdr = 4096,
    BufSize = 65536,
};

typedef struct WsFrame WsFrame;
struct WsFrame {
    int     fin;
    int     opcode;
    int     masked;
    uvlong  len;
    uchar   mask[4];
    uchar   *data;
};

char *addr = "tcp!*!8080";
int debug = 0;

/* Route table - add entries as needed */
typedef struct Route Route;
struct Route {
    char *path;
    char *addr;
};

Route routes[] = {
    { "/cpu",  "tcp!localhost!17019" },
    { "/auth", "tcp!localhost!567" },   /* placeholder for future */
    { "/",     "tcp!localhost!17019" }, /* default to cpu */
    { nil, nil },
};

void handler(int);
int httpupgrade(int, char*, int);
char *routelookup(char*);
char *wsaccept(char*);
int wsread(int, WsFrame*);
int wswrite(int, int, uchar*, uvlong);
void bridge(int, int);

void
usage(void)
{
    fprint(2, "usage: %s [-d] [-a addr]\n", argv0);
    exits("usage");
}

void
main(int argc, char **argv)
{
    int acfd, lcfd, dfd;
    char adir[40], ldir[40];
    
    ARGBEGIN{
    case 'd':
        debug++;
        break;
    case 'a':
        addr = EARGF(usage());
        break;
    default:
        usage();
    }ARGEND
    
    if(argc != 0)
        usage();
    
    acfd = announce(addr, adir);
    if(acfd < 0)
        sysfatal("announce %s: %r", addr);
    
    if(debug)
        fprint(2, "listening on %s\n", addr);
    
    for(;;){
        lcfd = listen(adir, ldir);
        if(lcfd < 0)
            sysfatal("listen: %r");
        
        switch(rfork(RFPROC|RFMEM|RFNOWAIT)){
        case -1:
            sysfatal("fork: %r");
        case 0:
            close(acfd);
            dfd = accept(lcfd, ldir);
            if(dfd < 0)
                exits("accept");
            close(lcfd);
            handler(dfd);
            exits(nil);
        default:
            close(lcfd);
        }
    }
}

void
handler(int fd)
{
    char path[128];
    char *backend;
    int p9fd;
    
    if(httpupgrade(fd, path, sizeof path) < 0){
        if(debug)
            fprint(2, "upgrade failed\n");
        return;
    }
    
    if(debug)
        fprint(2, "websocket connected, path=%s\n", path);
    
    backend = routelookup(path);
    if(backend == nil){
        if(debug)
            fprint(2, "no route for %s\n", path);
        return;
    }
    
    p9fd = dial(backend, nil, nil, nil);
    if(p9fd < 0){
        if(debug)
            fprint(2, "dial %s: %r\n", backend);
        return;
    }
    
    if(debug)
        fprint(2, "connected to %s\n", backend);
    
    bridge(fd, p9fd);
    
    close(p9fd);
    close(fd);
}
```

### HTTP Upgrade

```c
char*
routelookup(char *path)
{
    Route *r;
    for(r = routes; r->path != nil; r++){
        if(strcmp(path, r->path) == 0)
            return r->addr;
    }
    return nil;
}

int
httpupgrade(int fd, char *path, int pathlen)
{
    Biobuf bin;
    char *line, *key, *p, *q;
    char *accept;
    char response[512];
    int n;
    
    key = nil;
    path[0] = '\0';
    Binit(&bin, fd, OREAD);
    
    /* Read request line: GET /path HTTP/1.1 */
    line = Brdstr(&bin, '\n', 1);
    if(line == nil || strncmp(line, "GET ", 4) != 0){
        free(line);
        Bterm(&bin);
        return -1;
    }
    
    /* Extract path */
    p = line + 4;
    while(*p == ' ')
        p++;
    q = p;
    while(*q && *q != ' ' && *q != '?')
        q++;
    n = q - p;
    if(n >= pathlen)
        n = pathlen - 1;
    memmove(path, p, n);
    path[n] = '\0';
    
    free(line);
    
    /* Read headers */
    for(;;){
        line = Brdstr(&bin, '\n', 1);
        if(line == nil)
            break;
        
        /* Strip \r */
        n = strlen(line);
        if(n > 0 && line[n-1] == '\r')
            line[n-1] = '\0';
        
        /* Empty line = end of headers */
        if(line[0] == '\0'){
            free(line);
            break;
        }
        
        /* Look for Sec-WebSocket-Key */
        if(cistrncmp(line, "Sec-WebSocket-Key:", 18) == 0){
            key = strdup(line + 18);
            while(*key == ' ')
                key++;
        }
        
        free(line);
    }
    
    Bterm(&bin);
    
    if(key == nil)
        return -1;
    
    accept = wsaccept(key);
    
    n = snprint(response, sizeof response,
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n"
        "\r\n", accept);
    
    free(accept);
    
    if(write(fd, response, n) != n)
        return -1;
    
    return 0;
}

char*
wsaccept(char *key)
{
    char buf[128];
    uchar digest[SHA1dlen];
    char *enc;
    int n;
    
    snprint(buf, sizeof buf, "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key);
    sha1((uchar*)buf, strlen(buf), digest, nil);
    
    n = (SHA1dlen + 2) / 3 * 4 + 1;
    enc = malloc(n);
    enc64(enc, n, digest, SHA1dlen);
    
    return enc;
}
```

### WebSocket Frame Handling

```c
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
    
    /* Unmask */
    if(f->masked){
        for(n = 0; n < f->len; n++)
            f->data[n] ^= f->mask[n % 4];
    }
    
    return 0;
}

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
    if(len > 0 && write(fd, data, len) != len)
        return -1;
    
    return 0;
}
```

### Bridge Loop

```c
void
bridge(int wsfd, int p9fd)
{
    WsFrame f;
    uchar buf[BufSize];
    int n;
    int pid;
    
    /* Fork: one process for each direction */
    switch(pid = rfork(RFPROC|RFMEM)){
    case -1:
        sysfatal("fork: %r");
    case 0:
        /* Child: ws → 9p */
        for(;;){
            if(wsread(wsfd, &f) < 0)
                break;
            
            switch(f.opcode){
            case 0x2:  /* Binary */
                if(write(p9fd, f.data, f.len) != f.len){
                    free(f.data);
                    goto done;
                }
                break;
            case 0x8:  /* Close */
                wswrite(wsfd, 0x8, f.data, f.len);
                free(f.data);
                goto done;
            case 0x9:  /* Ping */
                wswrite(wsfd, 0xA, f.data, f.len);
                break;
            }
            free(f.data);
        }
    done:
        postnote(PNPROC, getppid(), "die");
        exits(nil);
    default:
        /* Parent: 9p → ws */
        for(;;){
            n = read(p9fd, buf, sizeof buf);
            if(n <= 0)
                break;
            if(wswrite(wsfd, 0x2, buf, n) < 0)
                break;
        }
        postnote(PNPROC, pid, "die");
    }
}
```

## mkfile

```makefile
</$objtype/mkfile

TARG=enoch
OFILES=enoch.$O

BIN=/$objtype/bin

</sys/src/cmd/mkone
```

## Installation

```sh
cd /sys/src/cmd/enoch
mk install
```

## Running

### Basic (testing with exportfs)

Edit the routes[] table in the source to point at exportfs:

```c
Route routes[] = {
    { "/cpu",  "tcp!localhost!564" },  /* exportfs */
    { "/",     "tcp!localhost!564" },
    { nil, nil },
};
```

```sh
# Start exportfs
exportfs -n -r / &

# Start trampoline
enoch -a 'tcp!*!8080'
```

### Production (CPU server)

Default routes point to cpu (17019) and auth (567):

```c
Route routes[] = {
    { "/cpu",  "tcp!localhost!17019" },
    { "/auth", "tcp!localhost!567" },
    { "/",     "tcp!localhost!17019" },
    { nil, nil },
};
```

```sh
enoch -a 'tcp!*!8080'
```

### With TLS

For wss://, use tlssrv:

```sh
# Generate certificate (once)
auth/rsagen -t 'service=tls owner=enoch' > /sys/lib/tls/enoch

# Run with TLS
tlssrv -c/sys/lib/tls/enoch -ltcp!*!8443 /bin/enoch
```

## Command Line Options

| Option | Description |
|--------|-------------|
| -d | Debug mode (print diagnostics) |
| -a addr | Listen address (default: tcp!*!8080) |

## Route Configuration

Routes are configured in the source code. Edit and recompile to change:

```c
Route routes[] = {
    { "/cpu",  "tcp!localhost!17019" },  /* cpu listener */
    { "/auth", "tcp!localhost!567" },    /* auth server (future) */
    { "/",     "tcp!localhost!17019" },  /* default */
    { nil, nil },
};
```

| Path | Default Backend | Purpose |
|------|-----------------|---------|
| /cpu | tcp!localhost!17019 | CPU server |
| /auth | tcp!localhost!567 | Auth server (future) |
| / | tcp!localhost!17019 | Default fallback |

## Security Considerations

1. **Run trampoline on the 9front box itself** - minimises exposure
2. **Use TLS (wss://)** - prevents eavesdropping
3. **Firewall WebSocket port** - restrict to trusted networks if possible
4. **The trampoline sees plaintext 9P** - it's a trusted component

## Error Handling

The trampoline should handle:

- Client disconnect (clean close frame or TCP reset)
- Backend disconnect (exportfs/cpu exit)
- Malformed WebSocket frames
- Memory allocation failures

On any error, both connections are closed and the handler exits.

## Testing

### Local Test

```sh
# Terminal 1: exportfs
exportfs -n -r /tmp &

# Terminal 2: trampoline
enoch -d -e 'tcp!localhost!564'

# Terminal 3: websocat (if available on another machine)
websocat ws://9front:8080/
```

### With Browser

Open the Enoch client in a browser and verify:
1. WebSocket connects
2. 9P Tversion/Rversion succeeds
3. Tattach/Rattach succeeds
4. File operations work

## Future Enhancements

- **Connection limiting** - prevent resource exhaustion
- **Access logging** - record connections for audit
- **Origin checking** - restrict which domains can connect
- **Metrics** - connection counts, bytes transferred
