"use client";

import { useEffect, useImperativeHandle, useRef } from "react";
import SignaturePadLib from "signature_pad";

export type SignaturePadHandle = {
  /** Transparent-background PNG data URL cropped to the stroke, or null when
   * nothing has been drawn. */
  toDataUrl: () => string | null;
  clear: () => void;
};

/**
 * A drawing surface backed by `signature_pad`.
 *
 * Three details decide whether the result looks like a signature rather than
 * a child's scribble, and all three are easy to omit:
 *
 * 1. The canvas backing store is sized in device pixels and the context is
 *    scaled to match. Without this the stroke is visibly pixellated on every
 *    phone, which is where most signing happens.
 * 2. `touch-action: none` on the canvas. Without it the drawing gesture
 *    scrolls the page instead of drawing.
 * 3. The exported PNG is cropped to the ink's bounding box, so the signature
 *    sits on the rule in the quote rather than floating inside a large
 *    transparent rectangle.
 */
export function SignaturePad({
  ref,
  onChange,
}: {
  ref?: React.Ref<SignaturePadHandle>;
  /** Fires whenever the canvas goes from empty to drawn or back, so the
   * parent can enable its confirm button. */
  onChange?: (hasInk: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const padRef = useRef<SignaturePadLib | null>(null);

  // Read from a ref, not a prop dependency, inside the construction effect
  // below. That effect creates the SignaturePadLib instance and tears it
  // down on cleanup, and unlike resize() -- which captures and restores
  // stroke data around a resize -- the teardown path here throws the pad
  // away with nothing preserved. SignatureDialog (signature-dialog.tsx)
  // currently passes a stable setState setter, so this isn't live yet, but
  // SignaturePad is a public primitive picking up two more callers; the
  // first one to pass an inline arrow function would change identity every
  // parent render and silently erase whatever the user had drawn. Updating
  // the ref in an effect (not during render) keeps it current without
  // making it a dependency anywhere.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pad = new SignaturePadLib(canvas, {
      penColor: "#111111",
      backgroundColor: "rgba(0,0,0,0)",
      minWidth: 0.7,
      maxWidth: 2.6,
    });
    padRef.current = pad;

    // Sizing the backing store to CSS pixels alone produces a blurred stroke
    // on any display with devicePixelRatio > 1. Resizing also clears the
    // canvas (signature_pad.js's clear() calls ctx.clearRect), so the ink is
    // captured and restored around it.
    //
    // Two things the naive version of this got wrong:
    //
    // - It must not run while a pointer is down. clear() resets
    //   `_strokePointerId` but leaves `_drawingStroke` true, so
    //   `_allowPointerId` (signature_pad.js) then rejects every later
    //   move/up event for that pointer: the rest of the stroke draws
    //   nothing and `endStroke` never fires. If it was the first stroke,
    //   onChange(true) never fires either, leaving ink on screen with the
    //   confirm button disabled. `drawing` below tracks this via the pad's
    //   own beginStroke/endStroke events, and a resize requested mid-stroke
    //   is deferred until endStroke instead of dropped.
    // - It must rescale points, not just replay them. `pad.fromData()`
    //   replays each group's absolute (x, y) points against whatever the
    //   canvas box is *now*. The canvas is h-full w-full in a flex layout,
    //   so portrait and landscape are genuinely different offsetWidth /
    //   offsetHeight, and replaying unscaled points shifts the signature
    //   toward a corner (or off the edge) instead of filling the new box.
    //   `lastWidth` / `lastHeight` remember the box size resize() last ran
    //   against, so the next call can compute a scale factor. Either being
    //   0 (the very first layout, before anything has a size) would divide
    //   by zero, so that case falls back to a 1:1 scale instead of
    //   Infinity/NaN -- harmless in practice, since there is nothing to
    //   scale until a signature exists.
    let drawing = false;
    let pendingResize = false;
    let lastWidth = 0;
    let lastHeight = 0;

    const resize = () => {
      if (drawing) {
        pendingResize = true;
        return;
      }

      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const oldWidth = lastWidth;
      const oldHeight = lastHeight;
      const newWidth = canvas.offsetWidth;
      const newHeight = canvas.offsetHeight;

      const data = pad.isEmpty() ? null : pad.toData();
      canvas.width = newWidth * ratio;
      canvas.height = newHeight * ratio;
      canvas.getContext("2d")?.scale(ratio, ratio);
      pad.clear();

      if (data) {
        const scaleX = oldWidth > 0 ? newWidth / oldWidth : 1;
        const scaleY = oldHeight > 0 ? newHeight / oldHeight : 1;
        pad.fromData(
          data.map((group) => ({
            ...group,
            points: group.points.map((point) => ({
              ...point,
              x: point.x * scaleX,
              y: point.y * scaleY,
            })),
          }))
        );
      }

      lastWidth = newWidth;
      lastHeight = newHeight;
    };

    resize();

    // A window resize/orientationchange is not the only way the canvas's
    // CSS box can change size -- a webfont swapping in above it can change
    // how much room the flex-1 wrapper leaves it, with no window resize
    // event at all, leaving the backing store DPI-mismatched to its CSS
    // box. ResizeObserver watches the canvas element itself, so it covers
    // that case as well as ordinary window resizes, making the window
    // "resize" listener redundant; orientationchange stays as a second
    // signal since some browsers fire it before layout has settled to its
    // new size.
    const observer = new ResizeObserver(() => resize());
    observer.observe(canvas);
    window.addEventListener("orientationchange", resize);

    const onBegin = () => {
      drawing = true;
    };
    const onEnd = () => {
      drawing = false;
      onChangeRef.current?.(!pad.isEmpty());
      if (pendingResize) {
        pendingResize = false;
        resize();
      }
    };
    pad.addEventListener("beginStroke", onBegin);
    pad.addEventListener("endStroke", onEnd);

    return () => {
      observer.disconnect();
      window.removeEventListener("orientationchange", resize);
      pad.removeEventListener("beginStroke", onBegin);
      pad.removeEventListener("endStroke", onEnd);
      pad.off();
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      toDataUrl: () => {
        const pad = padRef.current;
        if (!pad || pad.isEmpty()) return null;
        return cropToInk(pad);
      },
      clear: () => {
        padRef.current?.clear();
        onChangeRef.current?.(false);
      },
    }),
    []
  );

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full rounded-md border border-dashed border-neutral-300 bg-white"
      style={{ touchAction: "none" }}
      aria-label="Signature area"
    />
  );
}

/**
 * Re-draws the recorded strokes onto a canvas sized to their bounding box.
 * `signature_pad`'s own `toDataURL` exports the whole surface, which on a
 * desktop-sized pad is mostly empty space — and that space would then be
 * scaled down to fit the signature rule on the quote, shrinking the actual
 * signature to illegibility.
 */
function cropToInk(pad: SignaturePadLib): string | null {
  const groups = pad.toData();
  const points = groups.flatMap((group) => group.points);
  if (points.length === 0) return null;

  const padding = 8;
  const minX = Math.min(...points.map((p) => p.x)) - padding;
  const maxX = Math.max(...points.map((p) => p.x)) + padding;
  const minY = Math.min(...points.map((p) => p.y)) - padding;
  const maxY = Math.max(...points.map((p) => p.y)) + padding;

  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.ceil((maxX - minX) * ratio));
  out.height = Math.max(1, Math.ceil((maxY - minY) * ratio));

  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.scale(ratio, ratio);
  ctx.translate(-minX, -minY);

  const cropped = new SignaturePadLib(out, {
    penColor: "#111111",
    backgroundColor: "rgba(0,0,0,0)",
    minWidth: 0.7,
    maxWidth: 2.6,
  });
  cropped.fromData(groups, { clear: false });
  // This pad only ever renders one offscreen frame and is never drawn on,
  // but its constructor still registers pointer listeners (on(), called
  // internally). .off() releases them for symmetry with the main pad's
  // explicit cleanup above, even though nothing here leaks today.
  cropped.off();

  return out.toDataURL("image/png");
}
