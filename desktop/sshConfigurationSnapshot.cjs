'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { configValue } = require('./sshRouting.cjs');
function invalid() { return Object.assign(new Error('The native SSH Include tree cannot be safely copied for a managed tunnel. Use ordinary file paths and glob patterns, with at most 32 files and eight include levels.'), { code: 'SSH_CONFIGURATION_UNSUPPORTED' }); }
function includeWords(text) {
  const words = []; let word = '', quote = null, escaped = false, started = false;
  for (const character of text) {
    if (escaped) { word += character; escaped = false; started = true; }
    else if (character === '\\') escaped = true;
    else if (quote) { if (character === quote) quote = null; else word += character; }
    else if (character === '"' || character === "'") { quote = character; started = true; }
    else if (character === '#') break;
    else if (/\s/.test(character)) { if (started) { words.push(word); word = ''; started = false; } }
    else { word += character; started = true; }
  }
  if (quote || escaped) throw invalid();
  if (started) words.push(word);
  if (!words.length || words.some(value => /[%$\0\r\n]/.test(value))) throw invalid();
  return words;
}
function wildcard(pattern) {
  if (/[[\]]/.test(pattern)) throw invalid();
  return new RegExp('^' + pattern.split('').map(character => character === '*' ? '.*' : character === '?' ? '.' : character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$', process.platform === 'win32' ? 'i' : '');
}
async function expand(pattern, base) {
  const expanded = pattern === '~' ? os.homedir() : pattern.startsWith('~/') ? path.join(os.homedir(), pattern.slice(2)) : pattern;
  if (expanded.startsWith('~')) throw invalid();
  const absolute = path.resolve(base, expanded), root = path.parse(absolute).root;
  let matches = [root];
  for (const part of absolute.slice(root.length).split(path.sep)) {
    const next = [];
    for (const directory of matches) {
      if (!/[?*[\]]/.test(part)) { next.push(path.join(directory, part)); continue; }
      const names = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []; throw error; });
      const matcher = wildcard(part);
      for (const name of names.filter(name => matcher.test(name)).sort()) next.push(path.join(directory, name));
      if (next.length > 32) throw invalid();
    }
    matches = next;
  }
  const files = [];
  for (const filename of matches) {
    const stat = await fs.stat(filename).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });
    if (stat?.isFile()) files.push(filename);
  }
  return files;
}
async function snapshotNativeConfiguration({ directory, nativeConfigFile }) {
  const ownedDirectory = path.join(directory, '.ssh-policy-' + randomUUID());
  await fs.mkdir(ownedDirectory, { recursive: true, mode: 0o700 });
  const roots = nativeConfigFile ? [{ filename: nativeConfigFile, base: path.join(os.homedir(), '.ssh') }]
    : [{ filename: path.join(os.homedir(), '.ssh', 'config'), base: path.join(os.homedir(), '.ssh') },
      { filename: process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'ssh', 'ssh_config') : '/etc/ssh/ssh_config',
        base: process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'ssh') : '/etc/ssh' }];
  let count = 0, size = 0;
  async function copy(filename, base, ancestors = []) {
    const canonical = await fs.realpath(filename);
    if (ancestors.includes(canonical) || ancestors.length >= 8 || ++count > 32) throw invalid();
    const source = await fs.readFile(canonical, 'utf8'); size += Buffer.byteLength(source);
    if (size > 1024 * 1024 || source.includes('\0')) throw invalid();
    const output = [];
    for (const line of source.split(/\r?\n/)) {
      const directive = /^\s*([a-z]+)(?:\s*=\s*|\s+)(.*)$/i.exec(line);
      if (directive && /^(LocalForward|RemoteForward|DynamicForward|ClearAllForwardings)$/i.test(directive[1])) continue;
      if (directive?.[1].toLowerCase() !== 'include') { output.push(line); continue; }
      const snapshots = [];
      for (const pattern of includeWords(directive[2])) for (const child of await expand(pattern, base)) snapshots.push(await copy(child, base, [...ancestors, canonical]));
      output.push(...snapshots.map(child => 'Include ' + configValue(process.platform === 'win32' ? child.replace(/\\/g, '/') : child)));
    }
    const result = path.join(ownedDirectory, 'native-' + randomUUID() + '.conf');
    await fs.writeFile(result, output.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    return result;
  }
  try {
    const files = [];
    for (const root of roots) {
      const exists = await fs.stat(root.filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (exists?.isFile()) files.push(await copy(root.filename, root.base));
    }
    const combined = path.join(ownedDirectory, 'config');
    await fs.writeFile(combined, files.map(file => 'Host *\nInclude ' + configValue(process.platform === 'win32' ? file.replace(/\\/g, '/') : file)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    return { filename: combined, directory: ownedDirectory, dispose: () => fs.rm(ownedDirectory, { recursive: true, force: true }) };
  } catch (error) { await fs.rm(ownedDirectory, { recursive: true, force: true }); throw error; }
}
module.exports = { snapshotNativeConfiguration, includeWords };
