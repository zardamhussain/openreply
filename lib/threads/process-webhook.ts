import { prisma } from "@/lib/db/client";
import { getDMQueue, THREADS_REPLY_JOB_NAME } from "@/lib/queue/client";
import { parseThreadsReplyEvents } from "@/lib/threads/webhook";
import { Prisma } from "@/app/generated/prisma/client";

/**
 * A reply to answer, in the shape the queue job carries.
 *
 * `accountConnectionId` is the OpenReply account row that answers, so the
 * worker never has to guess which account a reply belongs to.
 */
export type ThreadsReplyEvent = {
  accountConnectionId: string;
  threadsUserId: string;
  replyId: string;
  replyText: string;
  replierUsername: string | null;
  rootPostId: string | null;
};

/**
 * Record the webhook and queue the replies it produced.
 *
 * The webhook event belongs to one workspace, so replies are queued per
 * workspace rather than all together.
 */
export async function enqueueThreadsReplyEvents({
  events,
  workspaceId,
  payload,
}: {
  events: ThreadsReplyEvent[];
  workspaceId: string;
  payload: unknown;
}) {
  if (events.length === 0) return;

  const webhookEvent = await prisma.webhookEvent.create({
    data: {
      object: "threads",
      payload: payload as Prisma.InputJsonValue,
      workspaceId,
      status: "PENDING",
    },
  });

  try {
    const queue = getDMQueue();

    for (const event of events) {
      await queue.add(
        THREADS_REPLY_JOB_NAME,
        {
          threadsUserId: event.threadsUserId,
          accountConnectionId: event.accountConnectionId,
          replyId: event.replyId,
          replyText: event.replyText,
          replierUsername: event.replierUsername,
          rootPostId: event.rootPostId,
        },
        {
          // Deterministic, so a retried notification cannot publish the same
          // reply twice.
          jobId: `threads_reply_${event.threadsUserId}_${event.replyId}`,
        }
      );
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "FAILED",
        errorMessage: message,
        processedAt: new Date(),
      },
    });
    throw error;
  }
}

/**
 * Turn a Threads notification into queued work.
 *
 * Only replies on the connected account's own posts are acted on. A reply
 * whose owner id matches no connected Threads account is dropped: without an
 * owner there is no account to answer under, and guessing one would publish
 * the reply on somebody else's post.
 */
export async function processThreadsWebhook({ payload }: { payload: unknown }) {
  const events = parseThreadsReplyEvents(payload);
  if (events.length === 0) return;

  const accounts = await prisma.socialAccount.findMany({
    where: {
      platform: "THREADS",
      platformUserId: { in: events.map((event) => event.threadsUserId) },
    },
    select: { id: true, platformUserId: true, workspaceId: true },
  });
  const accountMap = new Map(accounts.map((a) => [a.platformUserId, a]));

  const relevant = events.filter((event) => accountMap.has(event.threadsUserId));
  if (relevant.length === 0) return;

  // One notification can name accounts in different workspaces, so each
  // workspace gets its own webhook record.
  const byWorkspace = new Map<string, ThreadsReplyEvent[]>();
  for (const event of relevant) {
    const account = accountMap.get(event.threadsUserId)!;
    const list = byWorkspace.get(account.workspaceId) ?? [];
    list.push({
      accountConnectionId: account.id,
      threadsUserId: event.threadsUserId,
      replyId: event.replyId,
      replyText: event.replyText,
      replierUsername: event.replierUsername ?? null,
      rootPostId: event.rootPostId ?? null,
    });
    byWorkspace.set(account.workspaceId, list);
  }

  for (const [workspaceId, workspaceEvents] of byWorkspace) {
    await enqueueThreadsReplyEvents({
      events: workspaceEvents,
      workspaceId,
      payload,
    });
  }
}
