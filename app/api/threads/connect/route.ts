import { NextResponse } from "next/server";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { getBaseUrl } from "@/lib/env";
import { createOAuthState } from "@/lib/meta/oauth";
import { getThreadsAuthorizationUrl } from "@/lib/threads/oauth";

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.redirect(`${getBaseUrl()}/login`);
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.redirect(`${getBaseUrl()}/settings?threads=forbidden`);
  }

  // The authorization URL needs the app id, and building it throws when that
  // is missing. Without this check an incomplete .env surfaces as a 500 on a
  // plain <a> navigation, which reads to the user as a dead button. The
  // secret and the verify token are needed for the rest of the flow, so they
  // are reported together rather than one failure at a time.
  const missing = [
    "THREADS_APP_ID",
    "THREADS_APP_SECRET",
    "THREADS_VERIFY_TOKEN",
  ].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    return NextResponse.redirect(
      `${getBaseUrl()}/settings?threads=misconfigured&missing=${missing.join(",")}`
    );
  }

  const redirectUri = `${getBaseUrl()}/api/threads/callback`;
  const state = createOAuthState(context.workspaceId);

  return NextResponse.redirect(
    getThreadsAuthorizationUrl({ redirectUri, state })
  );
}
