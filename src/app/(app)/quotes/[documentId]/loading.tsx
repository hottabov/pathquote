import { BuilderSkeleton } from "@/components/page-skeletons";

/**
 * Shown while the builder's data is in flight. This route is the one most
 * worth a skeleton: it is `force-dynamic`, it reads the document, the client
 * and catalogue pickers, the app settings and every item's compatible
 * options, and until the slowest of those lands Next would otherwise hold the
 * previous page on screen with no sign that anything is happening.
 */
export default function DocumentBuilderLoading() {
  return <BuilderSkeleton />;
}
