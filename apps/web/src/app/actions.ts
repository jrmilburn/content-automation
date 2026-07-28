"use server";

import { loadAuthConfig } from "@studio-parallel/config";
import { resolveSafeReturnUrl } from "@studio-parallel/domain";

import { signIn, signOut } from "../auth";

export async function beginGoogleSignIn(formData: FormData): Promise<void> {
  const config = loadAuthConfig();
  const requestedReturn = formData.get("returnTo");
  const returnTo = resolveSafeReturnUrl(
    typeof requestedReturn === "string" ? requestedReturn : "/",
    config.PUBLIC_ORIGIN,
  );

  await signIn("google", { redirectTo: returnTo });
}

export async function endSession(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
