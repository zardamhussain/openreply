/**
 * Threads webhook payloads.
 *
 * Threads uses a completely different envelope from Instagram: it is flat,
 * with `topic` / `values` at the top level and no `object` / `entry` /
 * `changes` nesting. Nothing here can assume the Instagram shape.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface ThreadsWebhookReplyEvent {
  /** The app-scoped id of the account that owns the post being replied to. */
  threadsUserId: string;
  /** The media id of the reply itself. */
  replyId: string;
  replyText: string;
  replierUsername?: string;
  /** Media id of the thing that was replied to. */
  repliedToId?: string;
  /** Media id of the post the conversation hangs off. */
  rootPostId?: string;
  permalink?: string;
  timestamp?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The entries carried by a notification.
 *
 * Meta's documentation shows `values` as a single object, but live
 * notifications wrap it in an array. Both shapes are accepted so a payload
 * that follows either one is still read.
 */
function notificationValues(root: Record<string, unknown>): Record<string, unknown>[] {
  const values = root.values;
  if (Array.isArray(values)) {
    return values.map(asRecord).filter((v): v is Record<string, unknown> => Boolean(v));
  }
  const single = asRecord(values);
  return single ? [single] : [];
}

/**
 * Pull the reply events out of a Threads webhook payload.
 *
 * Only `topic: "moderate"` / `field: "replies"` carries something we can act
 * on; mentions, deletes and publishes are ignored. A reply without an id, or
 * without the owner of the root post, is dropped: without the owner id the
 * reply cannot be attributed to a connected account, and an unattributable
 * reply is worse than no reply at all — it would be queued against the wrong
 * account.
 *
 * The payload is untrusted input, so this never throws: a malformed body
 * simply yields no events.
 */
export function parseThreadsReplyEvents(
  payload: unknown
): ThreadsWebhookReplyEvent[] {
  const root = asRecord(payload);
  if (!root) return [];

  if (asString(root.topic) !== "moderate") return [];

  const events: ThreadsWebhookReplyEvent[] = [];

  for (const entry of notificationValues(root)) {
    if (asString(entry.field) !== "replies") continue;

    const value = asRecord(entry.value);
    if (!value) continue;

    const replyId = asString(value.id);
    const rootPost = asRecord(value.root_post);
    const threadsUserId = asString(rootPost?.owner_id);

    if (!replyId || !threadsUserId) continue;

    const repliedTo = asRecord(value.replied_to);

    events.push({
      threadsUserId,
      replyId,
      replyText: asString(value.text) ?? "",
      replierUsername: asString(value.username),
      repliedToId: asString(repliedTo?.id),
      rootPostId: asString(rootPost?.id),
      permalink: asString(value.permalink),
      timestamp: asString(value.timestamp),
    });
  }

  return events;
}

/**
 * Check the `X-Hub-Signature-256` header against the raw request body.
 *
 * Threads notifications are signed with the **Threads** app secret, not the
 * Meta app secret, so the two are not interchangeable. The signature covers
 * the raw body only, so the body has to be read before it is parsed.
 */
export function verifyThreadsWebhookSignature(
  rawBody: string,
  signature: string | null,
  appSecret: string | undefined
): boolean {
  if (!signature || !appSecret) return false;
  if (!signature.startsWith("sha256=")) return false;

  const received = signature.slice("sha256=".length).toLowerCase();
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const receivedBuffer = Buffer.from(received, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}
