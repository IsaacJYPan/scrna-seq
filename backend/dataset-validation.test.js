import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { validateClassicVisiumZip } = require('./datasetValidation');

function makeStoredZip(names) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of names) {
    const encoded = Buffer.from(name, 'utf8');
    const data = Buffer.from([0]);
    const local = Buffer.alloc(30 + encoded.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(encoded.length, 26);
    encoded.copy(local, 30);
    data.copy(local, 30 + encoded.length);
    locals.push(local);

    const central = Buffer.alloc(46 + encoded.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(encoded.length, 28);
    central.writeUInt32LE(offset, 42);
    encoded.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

async function inspect(names) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'traceomics-visium-validation-'));
  const file = path.join(root, 'bundle.zip');
  await fs.promises.writeFile(file, makeStoredZip(names));
  const handle = await fs.promises.open(file, 'r');
  try {
    const stat = await handle.stat();
    return await validateClassicVisiumZip(handle, stat.size);
  } finally {
    await handle.close();
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

const VALID_VISIUM_FILES = [
  'sample/outs/filtered_feature_bc_matrix.h5',
  'sample/outs/spatial/tissue_positions.csv',
  'sample/outs/spatial/scalefactors_json.json',
  'sample/outs/spatial/tissue_lowres_image.png',
];

describe('classic Visium dataset validation', () => {
  it('accepts one nested Space Ranger output inventory', async () => {
    await expect(inspect(VALID_VISIUM_FILES)).resolves.toEqual({ valid: true, errors: null });
  });

  it('accepts the legacy tissue position filename', async () => {
    await expect(inspect(VALID_VISIUM_FILES.map((name) => (
      name.endsWith('tissue_positions.csv') ? name.replace('tissue_positions.csv', 'tissue_positions_list.csv') : name
    )))).resolves.toEqual({ valid: true, errors: null });
  });

  it('returns a useful validation reason when a required image is absent', async () => {
    await expect(inspect(VALID_VISIUM_FILES.filter((name) => !name.endsWith('tissue_lowres_image.png'))))
      .resolves.toEqual({
        valid: false,
        errors: ['The Visium ZIP is missing one or more required Space Ranger files.'],
      });
  });

  it('rejects traversal and duplicate archive entries before analysis', async () => {
    await expect(inspect([...VALID_VISIUM_FILES, '../outside.txt']))
      .rejects.toThrow(/unsafe entry path/i);
    await expect(inspect([...VALID_VISIUM_FILES, VALID_VISIUM_FILES[0]]))
      .rejects.toThrow(/duplicate entries/i);
  });
});
