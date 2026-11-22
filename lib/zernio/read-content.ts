import { zernioRequest } from "@/lib/zernio/client";

/**
 * Reading a Zernio-connected account's own content.
 *
 * Zernio answers for both Instagram and Threads with the same endpoints, so
 * one module serves both platforms.
 */

export type ZernioPost = {
  id: string;
  caption: string;
  mediaType: string;
  permalink: string | null;
  thumbnailUrl: string | null;
  timestamp: string | null;
};

export async function getZernioAccountPosts({
  apiKey,
  accountId,
  limit = 25,
}: {
  apiKey: string;
  accountId: string;
  limit?: number;
}): Promise<ZernioPost[]> {
  const result = await zernioRequest<{
    posts: {
      id: string;
      message?: string;
      createdTime?: string;
      picture?: string;
      permalink?: string;
      mediaType?: string;
    }[];
  }>({
    apiKey,
    path: `/accounts/${encodeURIComponent(accountId)}/posts`,
  });

  return (result.posts ?? []).slice(0, limit).map((post) => ({
    id: post.id,
    caption: post.message ?? "",
    mediaType: post.mediaType ?? "text",
    permalink: post.permalink ?? null,
    thumbnailUrl: post.picture ?? null,
    timestamp: post.createdTime ?? null,
  }));
}

export async function getZernioAccountProfile({
  apiKey,
  accountId,
  platform,
}: {
  apiKey: string;
  accountId: string;
  platform: "instagram" | "threads";
}): Promise<{
  username: string;
  name: string | null;
  profilePictureUrl: string | null;
}> {
  const result = await zernioRequest<{
    accounts: {
      _id: string;
      username: string;
      displayName?: string;
      profilePicture?: string;
    }[];
  }>({ apiKey, path: `/accounts?platform=${platform}` });

  const account = (result.accounts ?? []).find((a) => a._id === accountId);
  if (!account)
    throw new Error(
      `Connected ${platform} account is unavailable in Zernio`
    );

  return {
    username: account.username,
    name: account.displayName ?? null,
    profilePictureUrl: account.profilePicture ?? null,
  };
}

/**
 * The Instagram media type a Zernio media type maps to, so a Zernio post and
 * a Meta post look the same to the post picker.
 */
export function toInstagramMediaType(mediaType: string): string {
  switch (mediaType) {
    case "video":
      return "VIDEO";
    case "carousel":
    case "album":
      return "CAROUSEL_ALBUM";
    case "image":
      return "IMAGE";
    default:
      return "TEXT_POST";
  }
}
