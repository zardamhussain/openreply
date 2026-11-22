import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getThreadsUserPosts } from "@/lib/threads/client";
import { createZernioContext } from "@/lib/zernio/context";
import {
  getZernioAccountPosts,
  toInstagramMediaType,
} from "@/lib/zernio/read-content";

export const runtime = "nodejs";

/**
 * The connected Threads account's own posts, for the campaign builder's post
 * picker. Instagram has an equivalent endpoint; Threads posts live on a
 * different API, so they need their own.
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
  // `all=true` loads the whole library, the way the Instagram endpoint does
  // for the campaign post picker.
  const loadAll = request.nextUrl.searchParams.get("all") === "true";
  const limitParam = request.nextUrl.searchParams.get("limit");
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : 25;
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 100)
    : 25;

  const account = requestedId
    ? await prisma.socialAccount.findFirst({
        where: { id: requestedId, workspaceId, platform: "THREADS" },
        select: {
          id: true,
          accessToken: true,
          provider: true,
          zernioAccountId: true,
        },
      })
    : await prisma.socialAccount.findFirst({
        where: { workspaceId, platform: "THREADS" },
        orderBy: { connectedAt: "desc" },
        select: {
          id: true,
          accessToken: true,
          provider: true,
          zernioAccountId: true,
        },
      });

  if (!account) {
    return NextResponse.json(
      { success: false, error: "Threads account not connected" },
      { status: 404 }
    );
  }

  try {
    // A Zernio-connected account holds its credentials at Zernio, so its
    // posts come from Zernio rather than the Meta Threads API.
    if (account.provider === "ZERNIO") {
      const context = await createZernioContext({
        workspaceId,
        zernioAccountId: account.zernioAccountId,
        platform: "threads",
      });
      const posts = await getZernioAccountPosts({
        apiKey: context.apiKey,
        accountId: context.accountId,
        limit: loadAll ? 100 : limit,
      });

      return NextResponse.json({
        success: true,
        data: posts.map((post) => ({
          id: post.id,
          caption: post.caption,
          media_type: toInstagramMediaType(post.mediaType),
          media_url: undefined,
          thumbnail_url: post.thumbnailUrl ?? undefined,
          permalink: post.permalink ?? undefined,
          timestamp: post.timestamp ?? "",
        })),
        limitations: ["Zernio returns the account's recent Threads posts."],
      });
    }

    const { posts } = await getThreadsUserPosts(
      decryptToken(account.accessToken),
      { limit: loadAll ? 100 : limit }
    );

    // The same shape the Instagram endpoint returns, so the post picker can
    // read either one.
    return NextResponse.json({
      success: true,
      data: posts.map((post) => ({
        id: post.id,
        caption: post.text ?? "",
        media_type: post.mediaType ?? "TEXT_POST",
        media_url: post.mediaUrl ?? undefined,
        thumbnail_url: post.mediaUrl ?? undefined,
        permalink: post.permalink ?? undefined,
        timestamp: post.timestamp ?? "",
      })),
      limitations: [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Threads Posts] Error:", error);
    return NextResponse.json(
      { success: false, error: message },
      { status: 502 }
    );
  }
}
