"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
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
  const [, setHasInk] = useState(false);

  const report = useCallback(
    (hasInk: boolean) => {
      setHasInk(hasInk);
      onChange?.(hasInk);
    },
    [onChange]
  );

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
    // canvas, so the ink is captured and restored around it.
    const resize = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const data = pad.isEmpty() ? null : pad.toData();
      canvas.width = canvas.offsetWidth * ratio;
      canvas.height = canvas.offsetHeight * ratio;
      canvas.getContext("2d")?.scale(ratio, ratio);
      pad.clear();
      if (data) pad.fromData(data);
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);

    const onEnd = () => report(!pad.isEmpty());
    pad.addEventListener("endStroke", onEnd);

    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
      pad.removeEventListener("endStroke", onEnd);
      pad.off();
    };
  }, [report]);

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
        report(false);
      },
    }),
    [report]
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

  return out.toDataURL("image/png");
}
