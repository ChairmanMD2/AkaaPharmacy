import { useEffect, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { Button, Modal } from './ui';
import { beep } from '../lib/scanner';

export const cameraScanSupported = () => typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;

/** Scan with the device camera (phones, tablets, and PCs whose browser supports it). Keeps scanning until closed. */
export function CameraScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  const cb = useRef(onCode);
  cb.current = onCode;

  useEffect(() => {
    let stop = false, stream: MediaStream | null = null, timer: ReturnType<typeof setTimeout> | null = null;
    const seen = new Map<string, number>();
    (async () => {
      try {
        const Det = (window as any).BarcodeDetector;
        const detector = new Det({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar', 'qr_code'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (stop) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = video.current!;
        v.srcObject = stream; await v.play();
        const tick = async () => {
          if (stop) return;
          try {
            const found = await detector.detect(v);
            const now = Date.now();
            for (const f of found) {
              const code = String(f.rawValue ?? '').trim();
              if (code && now - (seen.get(code) ?? 0) > 2500) { seen.set(code, now); cb.current(code); }     // same code is ignored for 2.5 s
            }
          } catch { /* a frame failed: keep going */ }
          timer = setTimeout(tick, 200);
        };
        void tick();
      } catch (e: any) {
        setErr(e?.name === 'NotAllowedError' ? 'Camera permission was refused. Allow the camera for this site in the browser address bar.' : 'The camera could not be started on this device.');
      }
    })();
    return () => { stop = true; if (timer) clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  return (
    <Modal title="Scan with camera" onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      {err ? <p role="alert" className="rounded-lg bg-badsoft p-3 text-sm text-bad">{err}</p> : (
        <>
          <video ref={video} playsInline muted className="aspect-[4/3] w-full rounded-lg bg-black object-cover" />
          <p className="mt-2 text-center text-xs text-muted">Hold the barcode inside the picture. You will hear a beep for each scan.</p>
        </>
      )}
    </Modal>
  );
}

export function CameraButton({ onCode, label = 'Scan' }: { onCode: (code: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!cameraScanSupported()) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)} title="Scan with the camera"><Camera size={16} />{label}</Button>
      {open && <CameraScanner onCode={(c) => { beep(true); onCode(c); }} onClose={() => setOpen(false)} />}
    </>
  );
}
