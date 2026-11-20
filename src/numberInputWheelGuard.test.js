import { afterEach, describe, expect, it } from 'vitest';
import { installNumberInputWheelGuard } from './numberInputWheelGuard';

describe('number input wheel guard', () => {
  let uninstall = () => {};
  afterEach(() => { uninstall(); document.body.innerHTML = ''; });

  it('releases focus from a number field before the wheel can change it', () => {
    document.body.innerHTML = '<input type="number" value="10" />';
    const input = document.querySelector('input');
    uninstall = installNumberInputWheelGuard();
    input.focus();
    input.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe('10');
  });

  it('leaves text fields focused', () => {
    document.body.innerHTML = '<input type="text" value="C141" />';
    const input = document.querySelector('input');
    uninstall = installNumberInputWheelGuard();
    input.focus();
    input.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
    expect(document.activeElement).toBe(input);
  });
});
