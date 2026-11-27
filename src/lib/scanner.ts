import { useEffect, useRef } from 'react';

/**
 * USB / Bluetooth barcode scanners behave like a very fast keyboard: they "type" the code and press Enter.
 * The detector tells a scan apart from a person typing by speed (scanner keys arrive a few milliseconds apart),
 * so scanning works from anywhere on a screen, not only when the search box is focused.
 */
export interface ScanDetector {
  /** Feed every key press. Returns the code when Enter completes a scan, otherwise null. */
  key(key: string, at: number): string | null;
  /** True when the keys seen since the last pause look like part of a scan already (2+ fast characters). */
  inBurst(): boolean;
  reset(): void;
}

export function createScanDetector({ maxGapMs = 45, minLength = 4 }: { maxGapMs?: number; minLength?: number } = {}): ScanDetector {
  let buf = '';
  let last = 0;
  let fast = 0;                         // characters that arrived quickly after the previous one
  return {
    key(key, at) {
      if (last && at - last > maxGapMs) { buf = ''; fast = 0; }       // a pause: start over
      if (key === 'Enter') {
        const code = buf, wasScan = fast >= minLength - 1 && code.length >= minLength;
        buf = ''; fast = 0; last = 0;
        return wasScan ? code : null;
      }
      if (key.length !== 1) return null;                              // ignore Shift, arrows, etc.
      if (last && at - last <= maxGapMs) fast++;
      buf += key; last = at;
      return null;
    },
    inBurst: () => fast >= 1,
    reset() { buf = ''; fast = 0; last = 0; },
  };
}

let audio: AudioContext | null = null;
/** A short beep so the cashier hears that a scan was accepted (high) or not found (low). */
export function beep(ok: boolean) {
  try {
    audio ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = ok ? 1500 : 320; g.gain.value = 0.06;
    o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + (ok ? 0.08 : 0.25));
  } catch { /* no audio: fine */ }
}

const isEditable = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !(el as HTMLInputElement).readOnly;

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Listen for scanner input anywhere on the page. `onScan` gets the code. While the cursor is in a text box the
 * scanner's characters are removed from it again, so the box is not littered with the barcode.
 * Put `data-scan-ignore` on a field that should receive scans as plain typing (for example the barcode field of a product).
 */
export function useBarcodeScanner(onScan: (code: string) => void, enabled = true) {
  const cb = useRef(onScan);
  cb.current = onScan;
  useEffect(() => {
    if (!enabled) return;
    const det = createScanDetector();
    let before: { el: HTMLInputElement | HTMLTextAreaElement; value: string } | null = null;
    let lastAt = 0;
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const active = document.activeElement;
      if (active?.closest('[data-scan-ignore]')) return;
      if (e.key.length === 1 && (!lastAt || e.timeStamp - lastAt > 45)) before = isEditable(active) ? { el: active, value: active.value } : null;   // text as it was before this burst of keys began
      lastAt = e.timeStamp;
      const code = det.key(e.key, e.timeStamp);
      if (code) {
        e.preventDefault(); e.stopPropagation();
        if (before && isEditable(active) && before.el === active) setNativeValue(active, before.value);
        before = null;
        cb.current(code);
      } else if (e.key === 'Enter') before = null;
    };
    window.addEventListener('keydown', down, true);
    return () => window.removeEventListener('keydown', down, true);
  }, [enabled]);
}

/** Match a scanned code to a product. Tolerates scanners that drop or add a leading zero (UPC-A vs EAN-13). */
export function findByBarcode<T extends { barcode?: string | null }>(items: T[], code: string): T | undefined {
  const c = code.trim();
  const stripped = c.replace(/^0+/, '');
  return items.find((d) => d.barcode && d.barcode.trim() === c) ?? items.find((d) => d.barcode && d.barcode.trim().replace(/^0+/, '') === stripped && stripped.length >= 6);
}
