import { LoadingState } from "../../components/states";
import { PageHeader } from "../../components/page-header";

export default function WorkspaceLoading() {
  return (
    <div className="page-stack">
      <PageHeader
        description="The current workspace view is being prepared."
        title="Loading workspace"
      />
      <LoadingState label="current workspace view" />
    </div>
  );
}
