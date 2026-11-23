import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getThreadsUser } from "@/lib/threads/client";
import { createZernioContext } from "@/lib/zernio/context";
import { getZernioAccountProfile } from "@/lib/zernio/read-content";

export const dynamic = "force-dynamic";

/**
 * Live profile lookup (username + avatar) for the campaign preview. Instagram
 * has an equivalent endpoint; Threads reads the profile from its own API.
 */
export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const requestedId = request.nextUrl.searchParams.get("socialAccountId");

  const account = await prisma.socialAccount.findFirst({
    where: {
      workspaceId,
      platform: "THREADS",
      ...(requestedId ? { id: requestedId } : {}),
    },
    orderBy: { connectedAt: "desc" },
    select: {
      id: true,
      accessToken: true,
      provider: true,
      zernioAccountId: true,
      zernioConnectionId: true,
    },
  });
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Threads account not connected" },
      { status: 400 }
    );
  }

  try {
    // A Zernio-connected account holds its credentials at Zernio, so its
    // profile comes from Zernio rather than the Meta Threads API.
    if (account.provider === "ZERNIO") {
      const context = await createZernioContext({
        workspaceId,
        zernioAccountId: account.zernioAccountId,
        zernioConnectionId: account.zernioConnectionId,
        platform: "threads",
      });
      const profile = await getZernioAccountProfile({
        apiKey: context.apiKey,
        accountId: context.accountId,
        platform: "threads",
      });
      return NextResponse.json(
        { success: true, data: profile },
        { headers: { "Cache-Control": "private, max-age=300" } }
      );
    }

    const user = await getThreadsUser(decryptToken(account.accessToken));
    return NextResponse.json(
      {
        success: true,
        data: {
          username: user.username,
          name: user.name ?? null,
          profilePictureUrl: user.profilePictureUrl ?? null,
        },
      },
      { headers: { "Cache-Control": "private, max-age=300" } }
    );
  } catch (err) {
    console.error("[Threads Profile] Error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to load profile" },
      { status: 500 }
    );
  }
}
