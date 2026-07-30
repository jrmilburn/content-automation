import { redirect } from "next/navigation";

/**
 * The account configuration screen lives under settings, which is where the
 * Instagram connection callback has always redirected. This route is kept so
 * existing links and bookmarks land on it rather than a dead end.
 */
export default function AccountsPage() {
  redirect("/settings/integrations");
}
