import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { decryptToken } from '@/lib/meta/oauth';
import {
  normalizeZernioEvent,
  normalizeZernioThreadsEvent,
  verifyZernioSignature,
} from '@/lib/zernio/normalize-event';
import { processInstagramWebhook } from '@/lib/queue/process-webhook';
import { enqueueThreadsReplyEvents } from '@/lib/threads/process-webhook';

const eventEnvelopeSchema = z.object({
  account: z.object({
    id: z.string().min(1),
    platform: z.enum(['instagram', 'threads']),
  }),
});

/**
 * Answer a Zernio webhook.
 *
 * A webhook is signed with the secret of the connection that registered it.
 * The connection id in the URL names it directly; without one, the signature
 * picks it, which keeps a webhook registered at the older URL working.
 */
export async function handleZernioWebhook(
  request: Request,
  workspaceId: string,
  connectionId: string | null
) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-zernio-signature');

  const select = { id: true, workspaceId: true, webhookId: true, webhookSecret: true };

  // The URL names one connection; without it every connection of the
  // workspace is a candidate and the signature picks the right one.
  const candidates = connectionId
    ? await prisma.zernioConnection
        .findFirst({ where: { id: connectionId, workspaceId }, select })
        .then((connection) => (connection ? [connection] : []))
    : await prisma.zernioConnection.findMany({ where: { workspaceId }, select });

  if (candidates.length === 0 || candidates.every((c) => !c.webhookId)) {
    return NextResponse.json({ error: 'Unknown subscription' }, { status: 404 });
  }

  const connection = candidates.find(
    (c) =>
      c.webhookId &&
      verifyZernioSignature({
        rawBody,
        signature,
        secret: decryptToken(c.webhookSecret),
      })
  );
  if (!connection) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = eventEnvelopeSchema.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ success: true, ignored: true });

  // Zernio subscriptions are account-wide. Drop other profiles before
  // persisting any payload.
  const account = await prisma.socialAccount.findFirst({
    where: {
      workspaceId,
      provider: 'ZERNIO',
      zernioAccountId: parsed.data.account.id,
      zernioConnectionId: connection.id,
    },
  });
  if (!account) return NextResponse.json({ success: true, ignored: true });

  // A Threads account answers with a published reply, so it takes the Threads
  // path rather than the Instagram one.
  if (account.platform === 'THREADS') {
    const reply = normalizeZernioThreadsEvent({ payload, account });
    if (!reply) return NextResponse.json({ success: true, ignored: true });
    try {
      await enqueueThreadsReplyEvents({
        events: [
          {
            accountConnectionId: account.id,
            threadsUserId: account.platformUserId,
            ...reply,
          },
        ],
        workspaceId,
        payload,
      });
      return NextResponse.json({ success: true });
    } catch {
      return NextResponse.json(
        { error: 'Webhook processing failed; retry delivery.' },
        { status: 500 }
      );
    }
  }

  const normalized = normalizeZernioEvent({ payload, account });
  if (!normalized) return NextResponse.json({ success: true, ignored: true });
  try {
    await processInstagramWebhook({
      payload: normalized,
      provider: 'ZERNIO',
      workspaceId,
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: 'Webhook processing failed; retry delivery.' },
      { status: 500 }
    );
  }
}
