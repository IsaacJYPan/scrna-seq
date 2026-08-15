'use strict';

function assertUInt(value, label) {
  if (!Number.isInteger(value) || value <= 0 || value > 0x7fffffff) {
    throw new Error(`${label} must be a positive 32-bit integer.`);
  }
}

function fourcc(value) {
  if (typeof value !== 'string' || value.length !== 4) throw new Error('FourCC must contain four bytes.');
  return Buffer.from(value, 'ascii');
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function chunk(id, data) {
  const padding = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([fourcc(id), uint32(data.length), data, padding]);
}

function list(type, data) {
  return chunk('LIST', Buffer.concat([fourcc(type), data]));
}

function mainHeader({ width, height, frameCount, fps, maxFrameBytes }) {
  const buffer = Buffer.alloc(56);
  buffer.writeUInt32LE(Math.round(1_000_000 / fps), 0);
  buffer.writeUInt32LE(Math.min(0xffffffff, maxFrameBytes * fps), 4);
  buffer.writeUInt32LE(0, 8);
  buffer.writeUInt32LE(0x10, 12); // AVIF_HASINDEX
  buffer.writeUInt32LE(frameCount, 16);
  buffer.writeUInt32LE(0, 20);
  buffer.writeUInt32LE(1, 24);
  buffer.writeUInt32LE(maxFrameBytes, 28);
  buffer.writeUInt32LE(width, 32);
  buffer.writeUInt32LE(height, 36);
  return buffer;
}

function streamHeader({ width, height, frameCount, fps, maxFrameBytes }) {
  const buffer = Buffer.alloc(56);
  fourcc('vids').copy(buffer, 0);
  fourcc('MJPG').copy(buffer, 4);
  buffer.writeUInt32LE(0, 8);
  buffer.writeUInt16LE(0, 12);
  buffer.writeUInt16LE(0, 14);
  buffer.writeUInt32LE(0, 16);
  buffer.writeUInt32LE(1, 20);
  buffer.writeUInt32LE(fps, 24);
  buffer.writeUInt32LE(0, 28);
  buffer.writeUInt32LE(frameCount, 32);
  buffer.writeUInt32LE(maxFrameBytes, 36);
  buffer.writeUInt32LE(0xffffffff, 40);
  buffer.writeUInt32LE(0, 44);
  buffer.writeInt16LE(0, 48);
  buffer.writeInt16LE(0, 50);
  buffer.writeInt16LE(Math.min(width, 32767), 52);
  buffer.writeInt16LE(Math.min(height, 32767), 54);
  return buffer;
}

function bitmapHeader({ width, height, maxFrameBytes }) {
  const buffer = Buffer.alloc(40);
  buffer.writeUInt32LE(40, 0);
  buffer.writeInt32LE(width, 4);
  buffer.writeInt32LE(height, 8);
  buffer.writeUInt16LE(1, 12);
  buffer.writeUInt16LE(24, 14);
  fourcc('MJPG').copy(buffer, 16);
  buffer.writeUInt32LE(maxFrameBytes, 20);
  return buffer;
}

function encodeMjpegAvi({ frames, width, height, fps = 10 }) {
  assertUInt(width, 'width');
  assertUInt(height, 'height');
  assertUInt(fps, 'fps');
  if (!Array.isArray(frames) || frames.length === 0 || frames.some(frame => !Buffer.isBuffer(frame) || frame.length === 0)) {
    throw new Error('frames must be a non-empty array of JPEG buffers.');
  }
  const maxFrameBytes = Math.max(...frames.map(frame => frame.length));
  const avih = chunk('avih', mainHeader({ width, height, frameCount: frames.length, fps, maxFrameBytes }));
  const strl = list('strl', Buffer.concat([
    chunk('strh', streamHeader({ width, height, frameCount: frames.length, fps, maxFrameBytes })),
    chunk('strf', bitmapHeader({ width, height, maxFrameBytes })),
  ]));
  const hdrl = list('hdrl', Buffer.concat([avih, strl]));

  const frameChunks = [];
  const indexEntries = [];
  let moviOffset = 4; // offsets are relative to the beginning of the movi list data
  for (const frame of frames) {
    const frameChunk = chunk('00dc', frame);
    frameChunks.push(frameChunk);
    const entry = Buffer.alloc(16);
    fourcc('00dc').copy(entry, 0);
    entry.writeUInt32LE(0x10, 4); // AVIIF_KEYFRAME
    entry.writeUInt32LE(moviOffset, 8);
    entry.writeUInt32LE(frame.length, 12);
    indexEntries.push(entry);
    moviOffset += frameChunk.length;
  }
  const movi = list('movi', Buffer.concat(frameChunks));
  const idx1 = chunk('idx1', Buffer.concat(indexEntries));
  const body = Buffer.concat([fourcc('AVI '), hdrl, movi, idx1]);
  return Buffer.concat([fourcc('RIFF'), uint32(body.length), body]);
}

module.exports = { encodeMjpegAvi };
