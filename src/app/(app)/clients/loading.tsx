import { ListPageSkeleton } from "@/components/page-skeletons";

export default function ClientsLoading() {
  return <ListPageSkeleton label="Loading clients" columns={5} />;
}
