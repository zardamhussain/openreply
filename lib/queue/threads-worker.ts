import { Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { MetaApiError } from "@/lib/meta/client";
import { zernioRequest } from "@/lib/zernio/client";
import { createZernioContext } from "@/lib/zernio/context";
import {
  createThreadsReplyContainer,
  publishThreadsContainer,
  ThreadsApiError,
} from "@/lib/threads/client";
import type { ProcessThreadsReplyJob } from "@/lib/queue/client";
import { renderMessageWithTracking, buildTrackedUrl, type MessageTrackedLink } from "@/lib/tracking/message";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { reserveWorkspaceDMSend, releaseWorkspaceDMReservation } from "@/lib/billing/usage";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";

/**
 * Threads has no private messaging, so a campaign that would answer an
 * Instagram comment with a DM answers a Threads reply with a published reply
 * instead. The campaign model, keyword matching, tracked links and delivery
 * log are the same; only the delivery call differs.
 */

/**
 * How many delivery attempts one reply gets. A retry that runs out of
 * attempts leaves the row FAILED so the delivery log shows what happened.
 */
const MAX_SEND_ATTEMPTS = 3;

/**
 * A Threads reply that fails in a way no retry will fix — the account lost
 * access, the post is gone, the reply was already published. Retrying these
 * only burns attempts.
 */
class UnrecoverableThreadsError extends Error {}

function isUnrecoverable(error: unknown): boolean {
  if (error instanceof ThreadsApiError) {
    // 190 is "invalid OAuth token"; 4 is "permission denied"; 10 is "the post
    // does not exist"; 32 is "object does not exist"; 33 is "object is not
    // available". None of them resolve by trying again.
    return [4, 10, 32, 33, 190].includes(error.code);
  }
  if (error instanceof MetaApiError) {
    // A Zernio failure carries the HTTP status as its code: 401 is an
    // invalid or expired key, 403 a permission problem, 404 a missing account
    // or post. Retrying does not fix any of them.
    return [401, 403, 404].includes(error.code);
  }
  return false;
}

/**
 * The campaigns that should answer this reply.
 *
 * A campaign is bound to a post, so a reply on that post matches it. A
 * campaign set to any post matches every reply. When the notification did not
 * say which post the reply hangs off, only any-post campaigns can match.
 */
async function findMatchingCampaigns(job: Job<ProcessThreadsReplyJob>) {
  const { threadsUserId, rootPostId, accountConnectionId } = job.data;

  return prisma.automation.findMany({
    where: {
      isActive: true,
      ...(accountConnectionId ? { socialAccountId: accountConnectionId } : {}),
      socialAccount: { platform: "THREADS", platformUserId: threadsUserId },
      OR: [
        ...(rootPostId ? [{ postId: rootPostId }] : []),
        { matchAnyPost: true },
      ],
    },
    include: {
      socialAccount: true,
      trackedLinks: {
        select: { slug: true, destinationUrl: true },
        orderBy: TRACKED_LINK_ORDER,
      },
    },
  });
}

/**
 * A Threads reply carries the tracked link in its text; there is no button to
 * hold it. The campaign message normally carries {link}, but a campaign made
 * through the API might not, and a reply without the link would do nothing.
 */
function withTrackedLink(text: string, primaryLink?: MessageTrackedLink): string {
  if (!primaryLink) return text;

  const trackedUrl = buildTrackedUrl(primaryLink.slug);
  if (text.includes(trackedUrl)) return text;

  return `${text.trim()}\n\n${trackedUrl}`.trim();
}

/**
 * Publish the campaign's answer as a reply to the comment.
 *
 * The tracked link is rendered into the reply text: Threads replies are plain
 * text, so there is no button to carry the link the way an Instagram DM
 * template does.
 */
async function publishReply({
  accessToken,
  threadsUserId,
  replyId,
  text,
}: {
  accessToken: string;
  threadsUserId: string;
  replyId: string;
  text: string;
}) {
  const container = await createThreadsReplyContainer(accessToken, {
    replyToId: replyId,
    text,
  });
  return publishThreadsContainer(accessToken, threadsUserId, container.id);
}

/**
 * Publish the answer through Zernio instead of the Meta Threads API.
 *
 * A Zernio-connected account holds its credentials at Zernio, so OpenReply
 * posts the reply through Zernio's comment endpoint. The reply is public on
 * Threads either way.
 */
async function publishReplyViaZernio({
  account,
  postId,
  replyId,
  text,
}: {
  account: { workspaceId: string; zernioAccountId: string | null };
  postId: string | null;
  replyId: string;
  text: string;
}) {
  const context = await createZernioContext({
    workspaceId: account.workspaceId,
    zernioAccountId: account.zernioAccountId,
    platform: "threads",
  });

  const result = await zernioRequest<{ data?: { commentId?: string } }>({
    apiKey: context.apiKey,
    path: `/inbox/comments/${encodeURIComponent(postId ?? replyId)}`,
    method: "POST",
    body: { accountId: context.accountId, commentId: replyId, message: text },
    // Zernio keeps the key for 24 hours, so a retried job replays the
    // original reply instead of publishing a second one.
    idempotencyKey: `threads-reply-${context.accountId}-${replyId}`,
  });

  if (!result?.data?.commentId)
    throw new Error("Zernio did not confirm the Threads reply");
}

export async function processThreadsReply(
  job: Job<ProcessThreadsReplyJob>
): Promise<void> {
  const { threadsUserId, replyId, replyText, replierUsername, rootPostId } =
    job.data;

  const account = await prisma.socialAccount.findFirst({
    where: { platform: "THREADS", platformUserId: threadsUserId },
    select: {
      id: true,
      workspaceId: true,
      username: true,
      accessToken: true,
      provider: true,
      zernioAccountId: true,
    },
  });
  if (!account) return;

  const automations = await findMatchingCampaigns(job);

  for (const automation of automations) {
    // The account's own reply is not a comment to answer.
    if (
      replierUsername &&
      account.username &&
      replierUsername.trim().toLowerCase() === account.username.trim().toLowerCase()
    ) {
      continue;
    }

    const matchResult = automation.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(replyText, automation.keywords, automation.wholeWordMatch);
    if (!matchResult.matched) continue;

    const existingLog = await prisma.deliveryLog.findUnique({
      where: { automationId_commentId: { automationId: automation.id, commentId: replyId } },
    });

    // Already answered, or still retrying: nothing left to do.
    if (existingLog?.status === "SENT") continue;
    if (existingLog?.deliveryUnconfirmed) continue;
    if ((existingLog?.attempts ?? 0) >= MAX_SEND_ATTEMPTS) continue;

    const reservation = await reserveWorkspaceDMSend(automation.workspaceId);
    if (!reservation.allowed) {
      await prisma.deliveryLog.upsert({
        where: { automationId_commentId: { automationId: automation.id, commentId: replyId } },
        create: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          socialAccountId: automation.socialAccountId,
          commenterId: replierUsername ?? replyId,
          commenterName: replierUsername ?? null,
          commentText: replyText,
          commentId: replyId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "SKIPPED_PLAN_LIMIT",
          errorMessage: "Workspace reply limit reached",
        },
        update: {
          status: "SKIPPED_PLAN_LIMIT",
          errorMessage: "Workspace reply limit reached",
        },
      });
      continue;
    }

    const text = withTrackedLink(
      renderMessageWithTracking({
        message: automation.dmMessage,
        commenterName: replierUsername,
        trackedLinks: automation.trackedLinks,
      }),
      automation.trackedLinks[0]
    );

    try {
      if (account.provider === "ZERNIO") {
        await publishReplyViaZernio({
          account,
          postId: rootPostId ?? null,
          replyId,
          text,
        });
      } else {
        const accessToken = decryptToken(account.accessToken);
        await publishReply({ accessToken, threadsUserId, replyId, text });
      }

      await prisma.deliveryLog.upsert({
        where: { automationId_commentId: { automationId: automation.id, commentId: replyId } },
        create: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          socialAccountId: automation.socialAccountId,
          commenterId: replierUsername ?? replyId,
          commenterName: replierUsername ?? null,
          commentText: replyText,
          commentId: replyId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "SENT",
          sentAt: new Date(),
          attempts: 1,
        },
        update: {
          status: "SENT",
          sentAt: new Date(),
          errorMessage: null,
          attempts: { increment: 1 },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      // A reply that was never delivered must not count against the
      // workspace's monthly send allowance.
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        reservation.periodStart
      );

      await prisma.deliveryLog.upsert({
        where: { automationId_commentId: { automationId: automation.id, commentId: replyId } },
        create: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          socialAccountId: automation.socialAccountId,
          commenterId: replierUsername ?? replyId,
          commenterName: replierUsername ?? null,
          commentText: replyText,
          commentId: replyId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "FAILED",
          errorMessage: message,
          attempts: 1,
          deliveryUnconfirmed: isUnrecoverable(error),
        },
        update: {
          status: "FAILED",
          errorMessage: message,
          attempts: { increment: 1 },
          deliveryUnconfirmed: isUnrecoverable(error),
        },
      });

      if (isUnrecoverable(error)) {
        throw new UnrecoverableThreadsError(message);
      }
      throw error;
    }
  }
}
