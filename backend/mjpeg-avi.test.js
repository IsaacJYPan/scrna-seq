import { describe, expect, it } from 'vitest';

const { encodeMjpegAvi } = require('../scripts/mjpegAvi');

describe('native acceptance MJPEG AVI encoder', () => {
  it('writes a bounded indexed AVI container around exact JPEG frames', () => {
    const first = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const second = Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]);
    const avi = encodeMjpegAvi({ frames: [first, second], width: 1440, height: 960, fps: 10 });

    expect(avi.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(avi.readUInt32LE(4)).toBe(avi.length - 8);
    expect(avi.subarray(8, 12).toString('ascii')).toBe('AVI ');
    expect(avi.includes(Buffer.from('MJPG'))).toBe(true);
    expect(avi.includes(Buffer.from('movi'))).toBe(true);
    expect(avi.includes(Buffer.from('idx1'))).toBe(true);
    expect(avi.indexOf(first)).toBeGreaterThan(0);
    expect(avi.indexOf(second)).toBeGreaterThan(avi.indexOf(first));
  });

  it('rejects missing frames and invalid dimensions', () => {
    expect(() => encodeMjpegAvi({ frames: [], width: 100, height: 100 })).toThrow(/frames/i);
    expect(() => encodeMjpegAvi({ frames: [Buffer.from([1])], width: 0, height: 100 }))
      .toThrow(/width/i);
  });
});
