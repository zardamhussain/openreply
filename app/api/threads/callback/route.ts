import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { encryptToken, verifyOAuthState } from "@/lib/meta/oauth";
import {
  getThreadsLongLivedToken,
  getThreadsUser,
} from "@/lib/threads/client";
import { exchangeThreadsCodeForToken } from "@/lib/threads/oauth";
import { canManageWorkspace } from "@/lib/workspace-access";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");
  const state = verifyOAuthState(request.nextUrl.searchParams.get("state"));
  const baseUrl = getBaseUrl();

  if (error) {
    return NextResponse.redirect(`${baseUrl}/settings?threads=denied`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${baseUrl}/settings?threads=invalid`);
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(`${baseUrl}/login`);
  }

  // The state carries the workspace the connect started in, and the user has
  // to be a manager of that same workspace. Without both checks the callback
  // would let anyone attach an account to a workspace they do not own.
  const membership = await prisma.workspaceMember.findFirst({
    where: {
      workspaceId: state.workspaceId,
      userId: session.user.id,
    },
  });

  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(`${baseUrl}/settings?threads=forbidden`);
  }

  try {
    const redirectUri = `${baseUrl}/api/threads/callback`;
    const { accessToken: shortLivedToken } = await exchangeThreadsCodeForToken({
      code,
      redirectUri,
    });
    const { accessToken: longLivedToken, expiresIn } =
      await getThreadsLongLivedToken(shortLivedToken);
    const user = await getThreadsUser(longLivedToken);

    if (!user.id) {
      throw new Error("Threads did not return an account id");
    }

    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
    const data = {
      username: user.username,
      name: user.name ?? null,
      accessToken: encryptToken(longLivedToken),
      tokenExpiresAt,
    };

    // Identity is per platform, so the account is looked up by the composite
    // key. A Threads id that is already connected to another workspace is
    // refused rather than moved.
    const existing = await prisma.socialAccount.findUnique({
      where: {
        platform_platformUserId: {
          platform: "THREADS",
          platformUserId: user.id,
        },
      },
      select: { id: true, workspaceId: true },
    });

    if (existing && existing.workspaceId !== state.workspaceId) {
      return NextResponse.redirect(
        `${baseUrl}/settings?threads=already_connected`
      );
    }

    if (existing) {
      const updated = await prisma.socialAccount.updateMany({
        where: { id: existing.id, workspaceId: state.workspaceId },
        data,
      });
      if (!updated.count) {
        return NextResponse.redirect(
          `${baseUrl}/settings?threads=already_connected`
        );
      }
    } else {
      await prisma.socialAccount.create({
        data: {
          ...data,
          workspaceId: state.workspaceId,
          platform: "THREADS",
          platformUserId: user.id,
          provider: "META",
        },
      });
    }

    return NextResponse.redirect(`${baseUrl}/dashboard?connected=true`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Threads Callback] Error:", err);
    // The message is the only diagnostic a self-hoster gets for a failed
    // connect, so persist it alongside the other operational events.
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "ERROR",
          workspaceId: state.workspaceId,
          message: "Threads connection failed",
          payload: { reason: message },
        },
      })
      .catch(() => {});

    return NextResponse.redirect(
      `${baseUrl}/settings?threads=failed&reason=${encodeURIComponent(
        message.slice(0, 200)
      )}`
    );
  }
}
