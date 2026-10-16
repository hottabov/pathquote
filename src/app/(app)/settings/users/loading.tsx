import { PageSkeleton } from "@/components/page-skeletons";

// Inside the Settings layout, so the settings nav stays put and only the
// panel beside it is replaced while the page loads.
export default function SettingsLoading() {
  return <PageSkeleton label="Loading settings" />;
}
