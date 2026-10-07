#!/usr/bin/env node
// Test 9P2000 over TCP against enoch server

import * as net from 'net';

// 9P constants
const NOTAG = 0xFFFF;
const NOFID = 0xFFFFFFFF;
const TVERSION = 100;
const RVERSION = 101;
const TATTACH = 104;
const RATTACH = 105;
const RERROR = 107;
const TWALK = 110;
const RWALK = 111;
const TREAD = 116;
const RREAD = 117;
const TOPEN = 112;
const ROPEN = 113;
const TCLUNK = 120;
const RCLUNK = 121;
const OREAD = 0;

function encodeString(s) {
  const encoded = Buffer.from(s, 'utf-8');
  const buf = Buffer.alloc(2 + encoded.length);
  buf.writeUInt16LE(encoded.length, 0);
  encoded.copy(buf, 2);
  return buf;
}

function encodeTversion(msize, version) {
  const versionBuf = encodeString(version);
  const size = 4 + 1 + 2 + 4 + versionBuf.length;
  const buf = Buffer.alloc(size);
  let off = 0;
  buf.writeUInt32LE(size, off); off += 4;
  buf.writeUInt8(TVERSION, off); off += 1;
  buf.writeUInt16LE(NOTAG, off); off += 2;
  buf.writeUInt32LE(msize, off); off += 4;
  versionBuf.copy(buf, off);
  return buf;
}

function encodeTattach(fid, afid, uname, aname, tag) {
  const unameBuf = encodeString(uname);
  const anameBuf = encodeString(aname);
  const size = 4 + 1 + 2 + 4 + 4 + unameBuf.length + anameBuf.length;
  const buf = Buffer.alloc(size);
  let off = 0;
  buf.writeUInt32LE(size, off); off += 4;
  buf.writeUInt8(TATTACH, off); off += 1;
  buf.writeUInt16LE(tag, off); off += 2;
  buf.writeUInt32LE(fid, off); off += 4;
  buf.writeUInt32LE(afid, off); off += 4;
  unameBuf.copy(buf, off); off += unameBuf.length;
  anameBuf.copy(buf, off);
  return buf;
}

function encodeTwalk(fid, newfid, wnames, tag) {
  const nameBufs = wnames.map(encodeString);
  const namesLen = nameBufs.reduce((sum, b) => sum + b.length, 0);
  const size = 4 + 1 + 2 + 4 + 4 + 2 + namesLen;
  const buf = Buffer.alloc(size);
  let off = 0;
  buf.writeUInt32LE(size, off); off += 4;
  buf.writeUInt8(TWALK, off); off += 1;
  buf.writeUInt16LE(tag, off); off += 2;
  buf.writeUInt32LE(fid, off); off += 4;
  buf.writeUInt32LE(newfid, off); off += 4;
  buf.writeUInt16LE(wnames.length, off); off += 2;
  for (const nb of nameBufs) {
    nb.copy(buf, off);
    off += nb.length;
  }
  return buf;
}

function encodeTopen(fid, mode, tag) {
  const size = 4 + 1 + 2 + 4 + 1;
  const buf = Buffer.alloc(size);
  buf.writeUInt32LE(size, 0);
  buf.writeUInt8(TOPEN, 4);
  buf.writeUInt16LE(tag, 5);
  buf.writeUInt32LE(fid, 7);
  buf.writeUInt8(mode, 11);
  return buf;
}

function encodeTread(fid, offset, count, tag) {
  const size = 4 + 1 + 2 + 4 + 8 + 4;
  const buf = Buffer.alloc(size);
  buf.writeUInt32LE(size, 0);
  buf.writeUInt8(TREAD, 4);
  buf.writeUInt16LE(tag, 5);
  buf.writeUInt32LE(fid, 7);
  buf.writeBigUInt64LE(BigInt(offset), 11);
  buf.writeUInt32LE(count, 19);
  return buf;
}

function encodeTclunk(fid, tag) {
  const size = 4 + 1 + 2 + 4;
  const buf = Buffer.alloc(size);
  buf.writeUInt32LE(size, 0);
  buf.writeUInt8(TCLUNK, 4);
  buf.writeUInt16LE(tag, 5);
  buf.writeUInt32LE(fid, 7);
  return buf;
}

function decodeRversion(buf) {
  const msize = buf.readUInt32LE(7);
  const vlen = buf.readUInt16LE(11);
  const version = buf.subarray(13, 13 + vlen).toString('utf-8');
  return { msize, version };
}

function decodeQid(buf, off) {
  return {
    type: buf.readUInt8(off),
    vers: buf.readUInt32LE(off + 1),
    path: buf.readBigUInt64LE(off + 5),
  };
}

function decodeRattach(buf) {
  return { qid: decodeQid(buf, 7) };
}

function decodeRwalk(buf) {
  const nqid = buf.readUInt16LE(7);
  const qids = [];
  let off = 9;
  for (let i = 0; i < nqid; i++) {
    qids.push(decodeQid(buf, off));
    off += 13;
  }
  return { qids };
}

function decodeRerror(buf) {
  const elen = buf.readUInt16LE(7);
  const ename = buf.subarray(9, 9 + elen).toString('utf-8');
  return { ename };
}

function decodeRread(buf) {
  const count = buf.readUInt32LE(7);
  const data = buf.subarray(11, 11 + count);
  return { count, data };
}

async function test9P(host, port) {
  console.log(`Connecting to ${host}:${port}...`);

  return new Promise((resolve, reject) => {
    const client = net.connect({ host, port }, async () => {
      console.log('Connected!');

      let pending = Buffer.alloc(0);
      const responses = [];
      let responseCallback = null;

      const waitForResponse = () => new Promise((res) => {
        if (responses.length > 0) {
          res(responses.shift());
        } else {
          responseCallback = res;
        }
      });

      client.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);

        while (pending.length >= 4) {
          const size = pending.readUInt32LE(0);
          if (pending.length < size) break;

          const msg = pending.subarray(0, size);
          pending = pending.subarray(size);

          if (responseCallback) {
            const cb = responseCallback;
            responseCallback = null;
            cb(msg);
          } else {
            responses.push(msg);
          }
        }
      });

      client.on('error', (err) => {
        console.error('Socket error:', err);
        reject(err);
      });

      client.on('close', () => {
        console.log('Connection closed');
        resolve();
      });

      try {
        // 1. Version
        console.log('\n--- Tversion ---');
        client.write(encodeTversion(8192, '9P2000'));
        const rvBuf = await waitForResponse();
        const type = rvBuf.readUInt8(4);
        if (type === RERROR) {
          const err = decodeRerror(rvBuf);
          throw new Error(`Version failed: ${err.ename}`);
        }
        const rv = decodeRversion(rvBuf);
        console.log(`Rversion: msize=${rv.msize}, version=${rv.version}`);

        // 2. Attach
        console.log('\n--- Tattach ---');
        const rootFid = 0;
        client.write(encodeTattach(rootFid, NOFID, 'none', '', 1));
        const raBuf = await waitForResponse();
        const raType = raBuf.readUInt8(4);
        if (raType === RERROR) {
          const err = decodeRerror(raBuf);
          throw new Error(`Attach failed: ${err.ename}`);
        }
        const ra = decodeRattach(raBuf);
        console.log(`Rattach: qid.type=0x${ra.qid.type.toString(16)}, path=${ra.qid.path}`);

        // 3. Walk to / (clone root to list it)
        console.log('\n--- Twalk (clone root) ---');
        const licenseFid = 1;
        client.write(encodeTwalk(rootFid, licenseFid, [], 2));
        const rwBuf = await waitForResponse();
        const rwType = rwBuf.readUInt8(4);
        if (rwType === RERROR) {
          const err = decodeRerror(rwBuf);
          throw new Error(`Walk /LICENSE failed: ${err.ename}`);
        }
        const rw = decodeRwalk(rwBuf);
        console.log(`Rwalk: ${rw.qids.length} qids`);
        for (const qid of rw.qids) {
          console.log(`  qid: type=0x${qid.type.toString(16)}, path=${qid.path}`);
        }

        // 4. Open
        console.log('\n--- Topen ---');
        client.write(encodeTopen(licenseFid, OREAD, 3));
        const roBuf = await waitForResponse();
        const roType = roBuf.readUInt8(4);
        if (roType === RERROR) {
          const err = decodeRerror(roBuf);
          throw new Error(`Open failed: ${err.ename}`);
        }
        console.log('File opened');

        // 5. Read
        console.log('\n--- Tread ---');
        client.write(encodeTread(licenseFid, 0, 512, 4));
        const rrBuf = await waitForResponse();
        const rrType = rrBuf.readUInt8(4);
        if (rrType === RERROR) {
          const err = decodeRerror(rrBuf);
          throw new Error(`Read failed: ${err.ename}`);
        }
        const rr = decodeRread(rrBuf);
        console.log(`Rread: ${rr.count} bytes`);
        console.log('--- content (first 200 chars) ---');
        console.log(rr.data.toString('utf-8').slice(0, 200));
        console.log('--- end ---');

        // 6. Clunk
        console.log('\n--- Tclunk ---');
        client.write(encodeTclunk(licenseFid, 5));
        const rcBuf = await waitForResponse();
        const rcType = rcBuf.readUInt8(4);
        if (rcType === RERROR) {
          const err = decodeRerror(rcBuf);
          throw new Error(`Clunk failed: ${err.ename}`);
        }
        console.log('File clunked');

        console.log('\n=== 9P Test Complete! ===');
        client.end();

      } catch (e) {
        console.error('Test failed:', e);
        client.end();
        reject(e);
      }
    });

    client.on('error', reject);
  });
}

// Get host/port from args
const host = process.argv[2] || 'localhost';
const port = parseInt(process.argv[3] || '9090', 10);

test9P(host, port).catch(console.error);
