import { ListPageSkeleton } from "@/components/page-skeletons";

export default function QuotesLoading() {
  return <ListPageSkeleton label="Loading quotes" columns={7} />;
}
