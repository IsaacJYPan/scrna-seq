import { expect, it } from 'vitest';
import { validateResultSemantics } from '../../shared/resultSemantics.mjs';

it('preserves explicitly declared labels, Unicode units and unknown meaning as inert data', () => {
  expect(validateResultSemantics(undefined, 'scatter')).toEqual({ role: null, title: null, entityType: null, axes: { x: { label: null, unit: null }, y: { label: null, unit: null } } });
  expect(validateResultSemantics({ role: 'diagnostic', title: '<script>inert</script>', metrics: { score: { label: 'Score', unit: 'µm' } } }, 'metrics', ['score']))
    .toEqual({ role: 'diagnostic', title: '<script>inert</script>', metrics: { score: { label: 'Score', unit: 'µm' } } });
});

it.each([
  [{ role: 'selected' }, 'metrics'], [{ title: 'x'.repeat(161) }, 'figure'], [{ title: 'line\nbreak' }, 'figure'],
  [{ title: '\ud800' }, 'table'], [{ entityType: 'cell' }, 'table'], [{ entityType: 'invented' }, 'scatter'],
  [{ axes: { z: { label: 'Dimension 3' } } }, 'scatter'], [{ axes: { x: { unit: 'x'.repeat(81) } } }, 'scatter'],
  [{ metrics: Object.fromEntries(Array.from({ length: 41 }, (_, index) => ['metric-' + index, {}])) }, 'metrics'],
  [JSON.parse('{"__proto__":{}}'), 'metrics'], [{ metrics: JSON.parse('{"constructor":{}}') }, 'metrics'],
])('rejects unsupported or unbounded declared semantics %#', (value, type) => {
  expect(() => validateResultSemantics(value, type)).toThrow();
});

it('rejects getters without invoking them and rejects a description for an absent source metric', () => {
  let read = false;
  const value = Object.defineProperty({}, 'title', { enumerable: true, get() { read = true; return 'Title'; } });
  expect(() => validateResultSemantics(value, 'figure')).toThrow(); expect(read).toBe(false);
  expect(() => validateResultSemantics({ metrics: { missing: { label: 'Missing' } } }, 'metrics', ['score'])).toThrow(/unsupported field/);
});

it('bounds encoded semantic metadata independently of result bytes', () => {
  const metrics = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`metric-${index}-${'鍵'.repeat(90)}`, { label: '名'.repeat(120), unit: '単'.repeat(80) }]));
  expect(() => validateResultSemantics({ metrics }, 'metrics')).toThrow(/16 KiB/);
});
