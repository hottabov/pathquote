import type { QuotationData } from "@/lib/quotation-data";

/**
 * The setup image (owner, relaying the director: managers should be able to
 * add a photo of the finished configuration -- usually already drawn in
 * SketchUp and shown to the customer -- to the first page, full width,
 * "гарно та красиво"). One image for the whole quote, not per item,
 * deliberately: the point is showing every item together. Renders full width,
 * after the header detail and before the price, so the customer sees what
 * they're buying before what it costs. Absolutely nothing renders when
 * there's no image -- no frame, no caption, no placeholder -- a quote without
 * one must look finished, not unfinished.
 */
export function SetupImage({ heroImage }: { heroImage: QuotationData["heroImage"] }) {
  if (!heroImage) return null;

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={heroImage} alt="" className="pq-hero-image" />;
}
