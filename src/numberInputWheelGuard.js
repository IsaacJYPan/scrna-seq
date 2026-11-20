// Browsers change a focused number field when the mouse wheel turns over it.
// Researchers scroll long settings forms right after typing a value, which
// silently turned thresholds such as "10" into "9.9". Releasing focus first
// lets the wheel scroll the page and leaves the typed value unchanged.
export function releaseNumberInputOnWheel(event) {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.type === 'number' && target === document.activeElement) {
    target.blur();
  }
}

export function installNumberInputWheelGuard(root = document) {
  root.addEventListener('wheel', releaseNumberInputOnWheel, { capture: true, passive: true });
  return () => root.removeEventListener('wheel', releaseNumberInputOnWheel, { capture: true });
}
