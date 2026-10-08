import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { parseDelimited, imageDimensions, fileFormat, inspectImportedFile, previewCapabilities, PREVIEW_LIMITS } = require('./artifactPreviews');
const directories = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=', 'base64');
afterEach(async () => { while (directories.length) await rm(directories.pop(), { recursive: true, force: true }); });

describe('bounded artifact previews', () => {
  it('handles quoted delimiters, escaped quotes, multiline fields and CRLF', () => {
    const source = '\uFEFFsample,note\r\nfirst,"contains, comma"\r\nsecond,"said ""hello""\nand continued"\r\nthird,end\r\n';
    expect(parseDelimited(source, ',', { offset: 1, limit: 1 })).toMatchObject({ columns: ['sample', 'note'], rows: [['second', 'said "hello"\nand continued']], offset: 1, hasMore: true });
    expect(parseDelimited('sample\tcondition\na\tcontrol\nb\ttreated', '\t')).toMatchObject({ rows: [['a', 'control'], ['b', 'treated']], hasMore: false });
  });
  it.each([
    ['a,a\n1,2', /unique/], ['a,\n1,2', /nonempty/], ['a,b\n1', /column count/],
    ['a,b\n1,"not closed', /not closed/], ['a,b\n1,"closed"x', /after a quoted/],
    ['a,b\n1,not"allowed', /Unexpected quote/],
  ])('rejects malformed delimited text: %s', (source, message) => expect(() => parseDelimited(source, ',')).toThrow(message));
  it('bounds fields and columns and does not pretend a scanned prefix is a complete table', () => {
    expect(() => parseDelimited('a\n' + 'x'.repeat(2001), ',')).toThrow(/2000/);
    expect(() => parseDelimited(Array.from({ length: 101 }, (_, index) => 'column-' + index).join(','), ',')).toThrow(/100 columns/);
    const result = parseDelimited('a,b\n1,2\n3,partial', ',', { truncated: true });
    expect(result.rows).toEqual([['1', '2']]); expect(result.hasMore).toBe(true); expect(result.truncated).toBe(true);
    expect(() => parseDelimited('a,b\n1,partial', ',', { offset: 10, truncated: true })).toThrow(/bounded preview scan/);
  });
  it('treats SVG, HTML and RDS as opaque metadata rather than executable previews', () => {
    expect(fileFormat('figure.svg')).toMatchObject({ type: 'file', preview: null, mime: 'application/octet-stream' });
    expect(fileFormat('index.html').preview).toBeNull();
    expect(fileFormat('analysis.rds')).toMatchObject({ type: 'object', preview: null });
    expect(previewCapabilities('object', { id: 'org.r-project.rds', version: '1' }, 100)).toEqual([]);
  });
  it('admits bounded raster bytes and rejects incorrect signatures', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'traceomics-preview-')); directories.push(directory);
    const file = path.join(directory, 'image'); await writeFile(file, png);
    const format = await inspectImportedFile({ path: file, originalFilename: 'image.png' });
    expect(format.metadata).toMatchObject({ 'org.traceomics.image:width': 1, 'org.traceomics.image:height': 1 });
    expect(previewCapabilities(format.type, { id: format.id, metadata: format.metadata }, png.length)).toEqual(['image']);
    expect(previewCapabilities(format.type, { id: format.id, metadata: format.metadata }, PREVIEW_LIMITS.imageBytes + 1)).toEqual([]);
    await writeFile(file, '<svg onload="alert(1)"></svg>');
    await expect(inspectImportedFile({ path: file, originalFilename: 'image.png' })).rejects.toThrow(/supported PNG/);
    expect(() => imageDimensions(Buffer.from([255, 216, 255, 255, 255]), 'org.iso.jpeg')).toThrow(/dimensions/);
  });
  it('records sample-sheet purpose while limiting preview validation claims', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'traceomics-samples-')); directories.push(directory);
    const file = path.join(directory, 'samples'); await writeFile(file, 'sample,condition\na,control\nb,treated\n');
    const format = await inspectImportedFile({ path: file, originalFilename: 'samples.csv' }, 'sample-sheet');
    expect(format.type).toBe('sample-sheet');
    expect(format.metadata['org.traceomics.preview:validation']).toBe('bounded-preview-only');
    await expect(inspectImportedFile({ path: file, originalFilename: 'samples.json' }, 'sample-sheet')).rejects.toThrow(/CSV or TSV/);
    await expect(inspectImportedFile({ path: file, originalFilename: 'samples.unknown' }, 'sample-sheet')).rejects.toThrow(/CSV or TSV/);
  });
});
