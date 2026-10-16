import { PageSkeleton } from "@/components/page-skeletons";

// The (app) group's own boundary: covers the dashboard, and is the brief
// stand-in while a section's layout (e.g. its region check) resolves before
// that section's own loading.tsx takes over. Its blocks wait a moment
// before appearing, so a quick hand-off never shows.
export default function AppLoading() {
  return <PageSkeleton />;
}
