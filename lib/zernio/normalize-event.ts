import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { parseCommentEvents } from '@/lib/meta/webhook';

type InstagramPayload = Parameters<typeof parseCommentEvents>[0];

const envelopeSchema = z.object({
  id: z.string().min(1),
  event: z.string(),
  account: z.object({ id: z.string(), platform: z.enum(['instagram', 'threads']) }),
  comment: z.object({
    id: z.string().min(1), platformPostId: z.string().min(1), text: z.string(),
    author: z.object({ id: z.string().min(1), username: z.string().optional(), isOwnAccount: z.boolean().optional() }),
  }).optional(),
  message: z.object({
    platformMessageId: z.string().min(1), direction: z.enum(['incoming', 'outgoing']),
    text: z.string().nullable(), sender: z.object({ id: z.string().min(1) }),
  }).optional(),
  conversation: z.object({ participantId: z.string().nullish() }).optional(),
  metadata: z.object({ postbackPayload: z.string().optional(), postbackTitle: z.string().optional() }).optional(),
  statusAt: z.string().optional(),
});

/** A Zernio account, as the event normalizers need to see it. */
export type ZernioEventAccount = {
  zernioAccountId: string | null;
  platformUserId: string;
  username: string;
};

export function verifyZernioSignature({ rawBody, signature, secret }: {
  rawBody: string; signature: string | null; secret: string;
}): boolean {
  if (!signature || !secret || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(signature, 'hex'), expected);
}

export function normalizeZernioEvent({ payload, account }: {
  payload: unknown; account: ZernioEventAccount;
}): InstagramPayload | null {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success || parsed.data.account.id !== account.zernioAccountId) return null;
  if (parsed.data.account.platform !== 'instagram') return null;
  const { event, comment, message, metadata, conversation, statusAt } = parsed.data;
  const entry: InstagramPayload['entry'][number] = { id: account.platformUserId, time: Date.now() };
  if (event === 'comment.received' && comment) {
    if (comment.author.isOwnAccount === true || comment.author.username?.trim().toLowerCase() === account.username.trim().toLowerCase()) return null;
    entry.changes = [{ field: 'comments', value: { id: comment.id, text: comment.text, from: comment.author, media: { id: comment.platformPostId } } }];
  } else if (event === 'message.received' && message?.direction === 'incoming') {
    const sender = { id: message.sender.id };
    entry.messaging = [metadata?.postbackPayload
      ? { sender, postback: { mid: message.platformMessageId, payload: metadata.postbackPayload, title: metadata.postbackTitle } }
      : { sender, message: { mid: message.platformMessageId, text: message.text ?? '' } }];
  } else if (event === 'message.read' && conversation?.participantId) {
    const watermark = statusAt ? Date.parse(statusAt) : undefined;
    entry.messaging = [{ sender: { id: conversation.participantId }, read: { watermark: watermark !== undefined && Number.isFinite(watermark) ? watermark : undefined } }];
  } else {
    return null;
  }
  return { object: 'instagram', entry: [entry] };
}

/**
 * A Threads comment, in the shape the Threads worker expects.
 *
 * A Threads comment is a reply to the account's post, so the comment id is
 * what gets answered and the post id is the root post it hangs off.
 */
export type ZernioThreadsReply = {
  replyId: string;
  replyText: string;
  replierUsername: string | null;
  rootPostId: string;
};

export function normalizeZernioThreadsEvent({ payload, account }: {
  payload: unknown; account: ZernioEventAccount;
}): ZernioThreadsReply | null {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success || parsed.data.account.id !== account.zernioAccountId) return null;
  if (parsed.data.account.platform !== 'threads') return null;

  const { event, comment } = parsed.data;
  if (event !== 'comment.received' || !comment) return null;
  if (comment.author.isOwnAccount === true || comment.author.username?.trim().toLowerCase() === account.username.trim().toLowerCase()) return null;

  return {
    replyId: comment.id,
    replyText: comment.text,
    replierUsername: comment.author.username ?? null,
    rootPostId: comment.platformPostId,
  };
}
