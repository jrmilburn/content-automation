import { classifyError } from "@studio-parallel/observability";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "../../components/app-shell";
import { requireShellActor } from "../../lib/server/shell-session";

export default async function AuthenticatedLayout({ children }: Readonly<{ children: ReactNode }>) {
  const cookieStore = await cookies();
  const hadSession = cookieStore
    .getAll()
    .some(({ name }) => name.endsWith("authjs.session-token") || name === "studio-test-session");

  try {
    await requireShellActor();
  } catch (error) {
    const details = classifyError(error);
    if (details.errorCode !== "ACCESS_DENIED") throw error;

    const reason = hadSession ? "session_expired" : "sign_in_required";
    redirect(`/login?reason=${reason}&returnTo=%2F`);
  }

  return <AppShell>{children}</AppShell>;
}
