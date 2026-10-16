import { ListPageSkeleton } from "@/components/page-skeletons";

export default function DocumentsLoading() {
  return <ListPageSkeleton label="Loading documents" search={false} columns={4} rows={5} />;
}
