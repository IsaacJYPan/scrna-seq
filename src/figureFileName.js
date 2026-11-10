// Reduce a server-reported figure path or name to a display-safe base file name.
// Returns '' when nothing safe remains so callers can fall back to another field.
export function safeFigureFileName(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim().replace(/[?#].*$/, '');
  if (!candidate || /[\0\r\n]/.test(candidate)) return '';
  const fileName = candidate.split(/[\\/]+/).pop();
  return fileName && fileName !== '.' && fileName !== '..' ? fileName.slice(0, 180) : '';
}
