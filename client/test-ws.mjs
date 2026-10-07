#!/usr/bin/env node
// Test 9P2000 over WebSocket via enoch trampoline

import WebSocket from 'ws';

const NOTAG = 0xFFFF;
const NOFID = 0xFFFFFFFF;
const TVERSION = 100;
const RVERSION = 101;
const TATTACH = 104;
const RERROR = 107;

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

function decodeRversion(buf) {
  const msize = buf.readUInt32LE(7);
  const vlen = buf.readUInt16LE(11);
  const version = buf.subarray(13, 13 + vlen).toString('utf-8');
  return { msize, version };
}

function decodeRerror(buf) {
  const elen = buf.readUInt16LE(7);
  const ename = buf.subarray(9, 9 + elen).toString('utf-8');
  return { ename };
}

const url = process.argv[2] || 'ws://localhost:12345/cpu';
console.log(`Connecting to ${url}...`);

const ws = new WebSocket(url);
let pending = Buffer.alloc(0);
let responseCallback = null;

const waitForResponse = () => new Promise((res) => {
  responseCallback = res;
});

ws.on('open', async () => {
  console.log('WebSocket connected!');

  try {
    // 1. Version
    console.log('\n--- Tversion ---');
    ws.send(encodeTversion(8192, '9P2000'));
    const rvBuf = await waitForResponse();
    const type = rvBuf.readUInt8(4);
    if (type === RERROR) {
      const err = decodeRerror(rvBuf);
      throw new Error(`Version failed: ${err.ename}`);
    }
    if (type !== RVERSION) {
      throw new Error(`Unexpected type: ${type}`);
    }
    const rv = decodeRversion(rvBuf);
    console.log(`Rversion: msize=${rv.msize}, version=${rv.version}`);

    // 2. Attach
    console.log('\n--- Tattach ---');
    ws.send(encodeTattach(0, NOFID, 'none', '', 1));
    const raBuf = await waitForResponse();
    const raType = raBuf.readUInt8(4);
    if (raType === RERROR) {
      const err = decodeRerror(raBuf);
      throw new Error(`Attach failed: ${err.ename}`);
    }
    console.log('Rattach received!');

    console.log('\n=== WebSocket 9P Test Complete! ===');
    ws.close();

  } catch (e) {
    console.error('Test failed:', e);
    ws.close();
  }
});

ws.on('message', (data) => {
  const buf = Buffer.from(data);
  pending = Buffer.concat([pending, buf]);

  while (pending.length >= 4) {
    const size = pending.readUInt32LE(0);
    if (pending.length < size) break;

    const msg = pending.subarray(0, size);
    pending = pending.subarray(size);

    if (responseCallback) {
      const cb = responseCallback;
      responseCallback = null;
      cb(msg);
    }
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
});

ws.on('close', () => {
  console.log('Connection closed');
});
