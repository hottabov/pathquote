import { ListPageSkeleton } from "@/components/page-skeletons";

export default function SeriesLoading() {
  return <ListPageSkeleton label="Loading series" back search={false} columns={4} />;
}
