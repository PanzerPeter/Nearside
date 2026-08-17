import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import {
  clampOffset,
  clampZoom,
  coverScale,
  cropRect,
  MAX_ZOOM,
  MIN_ZOOM,
  pinchDistance,
  zoomAbout,
  type Offset,
} from '../lib/avatar-crop';
import { AVATAR_MAX_EDGE, replaceExtension } from '../lib/compress';
import { useT } from '../hooks/useT';

/** Working resolution the picked photo is decoded down to before framing. An
 *  8 MP camera frame kept at full size makes the drag stutter on a mid-range
 *  phone, and nothing above this survives the crop to `AVATAR_MAX_EDGE`. */
const PREVIEW_MAX_EDGE = 1280;
const QUALITY = 0.85;

interface Normalized {
  /** EXIF rotation already applied, so the preview and the crop agree. Null on
   *  the fallback path, where the crop reads the <img> element instead. */
  source: CanvasImageSource | null;
  url: string;
  width: number;
  height: number;
  revoke?: () => void;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Decode `file` once, with the orientation phone cameras record in EXIF baked
 * in. Both the preview and the crop read the result, so a portrait photo can't
 * be framed upright and then uploaded on its side.
 */
async function normalize(file: File): Promise<Normalized> {
  const fallback = (): Normalized => {
    const url = URL.createObjectURL(file);
    return { source: null, url, width: 0, height: 0, revoke: () => URL.revokeObjectURL(url) };
  };
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return fallback();

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const ratio = Math.min(1, PREVIEW_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * ratio));
    const height = Math.max(1, Math.round(bitmap.height * ratio));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return fallback();
    ctx.drawImage(bitmap, 0, 0, width, height);

    const url = canvas.toDataURL('image/png');
    return { source: canvas, url, width, height };
  } catch {
    return fallback();
  } finally {
    bitmap?.close();
  }
}

interface AvatarCropperProps {
  file: File;
  /** Receives the square crop, already sized for upload. */
  onCropped: (file: File) => void;
  onCancel: () => void;
}

/**
 * Frames a picked photo before it becomes an avatar: drag to pan, pinch or the
 * slider to zoom, and what the circle shows is what gets uploaded. The old
 * behaviour took the centre of whatever was picked, which cropped the head off
 * most portrait photos.
 *
 * The geometry lives in `lib/avatar-crop.ts`; this file is the gesture
 * plumbing and the canvas that turns the framing into a file.
 */
export function AvatarCropper({ file, onCropped, onCancel }: AvatarCropperProps) {
  const t = useT();
  const [image, setImage] = useState<Normalized | null>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState(0);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [working, setWorking] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Live pointers, by id. Two of them means a pinch; the previous positions are
  // what each move is measured against.
  const pointers = useRef(new Map<number, Offset>());

  useEffect(() => {
    let active = true;
    let revoke: (() => void) | undefined;
    void normalize(file).then((result) => {
      if (!active) {
        result.revoke?.();
        return;
      }
      revoke = result.revoke;
      setImage(result);
      if (result.width) setNatural({ width: result.width, height: result.height });
    });
    return () => {
      active = false;
      revoke?.();
    };
  }, [file]);

  // The viewport is a CSS square that sizes itself to the dialog, and every
  // clamp below is in its pixels — so it has to be measured, not assumed.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewport(entry.contentRect.width);
    });
    observer.observe(frame);
    setViewport(frame.clientWidth);
    return () => observer.disconnect();
  }, [image]);

  const ready = viewport > 0 && natural.width > 0 && natural.height > 0;

  const applyZoom = useCallback(
    (next: number, focus: Offset) => {
      setZoom((current) => {
        const target = clampZoom(next);
        setOffset((o) =>
          clampOffset(
            zoomAbout(o, focus, current, target),
            natural.width,
            natural.height,
            viewport,
            target
          )
        );
        return target;
      });
    },
    [natural.width, natural.height, viewport]
  );

  function localPoint(e: React.PointerEvent): Offset {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    // Relative to the viewport's centre, which is where the transform's origin
    // and every clamp are anchored.
    return { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 };
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (!ready) return;
    // Capture so a finger that slides off the circle keeps driving the pan
    // instead of stranding it mid-drag.
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, localPoint(e));
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!ready || !pointers.current.has(e.pointerId)) return;
    const point = localPoint(e);
    const previous = new Map(pointers.current);
    pointers.current.set(e.pointerId, point);

    const ids = [...previous.keys()];
    if (ids.length >= 2) {
      const [a, b] = ids;
      const beforeA = previous.get(a)!;
      const beforeB = previous.get(b)!;
      const afterA = pointers.current.get(a)!;
      const afterB = pointers.current.get(b)!;
      const before = pinchDistance(beforeA, beforeB);
      const after = pinchDistance(afterA, afterB);
      if (before <= 0) return;
      const focus = { x: (beforeA.x + beforeB.x) / 2, y: (beforeA.y + beforeB.y) / 2 };
      const focusNow = { x: (afterA.x + afterB.x) / 2, y: (afterA.y + afterB.y) / 2 };
      const target = clampZoom(zoom * (after / before));
      setZoom(target);
      setOffset((o) => {
        const zoomed = zoomAbout(o, focus, zoom, target);
        // The midpoint moving is a two-finger drag; carry it, or a pinch that
        // drifts fights the pan.
        const panned = { x: zoomed.x + (focusNow.x - focus.x), y: zoomed.y + (focusNow.y - focus.y) };
        return clampOffset(panned, natural.width, natural.height, viewport, target);
      });
      return;
    }

    const from = previous.get(e.pointerId)!;
    setOffset((o) =>
      clampOffset(
        { x: o.x + (point.x - from.x), y: o.y + (point.y - from.y) },
        natural.width,
        natural.height,
        viewport,
        zoom
      )
    );
  }

  function endPointer(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function handleWheel(e: React.WheelEvent) {
    if (!ready) return;
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    const focus = {
      x: e.clientX - rect.left - rect.width / 2,
      y: e.clientY - rect.top - rect.height / 2,
    };
    applyZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), focus);
  }

  async function confirm() {
    const source = image?.source ?? imgRef.current;
    if (!source || !ready || working) return;
    setWorking(true);
    try {
      const rect = cropRect(natural.width, natural.height, viewport, zoom, offset);
      const edge = Math.max(1, Math.round(Math.min(AVATAR_MAX_EDGE, rect.size)));
      const canvas = document.createElement('canvas');
      canvas.width = edge;
      canvas.height = edge;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        onCropped(file);
        return;
      }
      ctx.drawImage(source, rect.sx, rect.sy, rect.size, rect.size, 0, 0, edge, edge);

      // WebP for the same reason `compressImage` prefers it; a browser without
      // the encoder hands back a PNG, which is still a correct avatar.
      const blob = (await canvasToBlob(canvas, 'image/webp', QUALITY)) ??
        (await canvasToBlob(canvas, 'image/png', QUALITY));
      if (!blob) {
        onCropped(file);
        return;
      }
      const extension = blob.type === 'image/webp' ? 'webp' : 'png';
      onCropped(
        new File([blob], replaceExtension(file.name, extension), {
          type: blob.type,
          lastModified: Date.now(),
        })
      );
    } catch {
      // Framing is an improvement, never a gate on setting an avatar.
      onCropped(file);
    } finally {
      setWorking(false);
    }
  }

  const scale = coverScale(natural.width, natural.height, viewport) * zoom;

  return (
    <Modal
      title={t('cropper.title')}
      onClose={onCancel}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={working}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void confirm()} disabled={!ready || working}>
            {working ? <span className="loading loading-spinner loading-sm" /> : 'Use photo'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div
          ref={frameRef}
          className="relative w-full max-w-72 mx-auto aspect-square overflow-hidden rounded-full bg-base-300 touch-none select-none cursor-grab active:cursor-grabbing"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onWheel={handleWheel}
        >
          {image?.url ? (
            <img
              ref={imgRef}
              src={image.url}
              alt=""
              draggable={false}
              onLoad={(e) => {
                // Only the fallback path (no createImageBitmap) arrives here
                // without dimensions already known.
                if (!natural.width) {
                  setNatural({
                    width: e.currentTarget.naturalWidth,
                    height: e.currentTarget.naturalHeight,
                  });
                }
              }}
              className="absolute left-1/2 top-1/2 max-w-none origin-center"
              style={{
                width: natural.width || undefined,
                height: natural.height || undefined,
                transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              }}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center">
              <span className="loading loading-spinner text-primary" />
            </div>
          )}
        </div>

        <label className="flex items-center gap-3">
          <span className="text-xs text-base-content/60 w-10 shrink-0">Zoom</span>
          <input
            type="range"
            className="range range-primary range-sm"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            disabled={!ready}
            onChange={(e) => applyZoom(Number(e.target.value), { x: 0, y: 0 })}
          />
        </label>
        <p className="text-xs text-base-content/60 text-center">{t('cropper.hint')}</p>
      </div>
    </Modal>
  );
}
