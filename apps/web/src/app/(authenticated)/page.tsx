import { Dashboard } from "../../components/dashboard";
import { loadDashboardSummary } from "../../lib/server/dashboard-summary";

export default async function DashboardPage() {
  const summary = await loadDashboardSummary();

  return <Dashboard summary={summary} />;
}
