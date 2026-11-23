import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { getBaseUrl } from '@/lib/env';
import { decryptToken, encryptToken } from '@/lib/meta/oauth';
import { zernioRequest } from '@/lib/zernio/client';
import { withConnectionLock } from '@/lib/zernio/lock-connection';
import { ensureWebhook, listInstagramAccounts, listProfiles, listThreadsAccounts, listWebhooks } from '@/lib/zernio/manage-remote';
import { ConnectionError, readBody, withZernioManagement } from '@/lib/zernio/route-handler';

const keyBodySchema = z.object({
  apiKey: z.string().min(1).max(512),
  label: z.string().max(120).optional(),
});
const profileBodySchema = z.object({
  connectionId: z.string().min(1),
  profileId: z.string().min(1),
  label: z.string().max(120).optional(),
});
const connectionBodySchema = z.object({ connectionId: z.string().min(1) });

export const GET = withZernioManagement(async ({ workspaceId }) => {
  const connections = await prisma.zernioConnection.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      apiKey: true,
      label: true,
      profileId: true,
      webhookId: true,
    },
  });

  const data = await Promise.all(connections.map(async (connection) => {
    const apiKey = decryptToken(connection.apiKey);
    const [profiles, accounts, threadsAccounts] = await Promise.all([
      listProfiles(apiKey),
      connection.profileId ? listInstagramAccounts({ apiKey, profileId: connection.profileId }) : [],
      connection.profileId ? listThreadsAccounts({ apiKey, profileId: connection.profileId }) : [],
    ]);
    // Only the accounts imported through this connection count as connected
    // for it. Another connection's accounts are listed under that one.
    const connected = await prisma.socialAccount.findMany({
      where: { zernioConnectionId: connection.id },
      select: { zernioAccountId: true },
    });
    const connectedIds = new Set(connected.map(a => a.zernioAccountId));
    return {
      id: connection.id,
      label: connection.label,
      profileId: connection.profileId,
      webhookReady: Boolean(connection.webhookId),
      profiles,
      accounts: accounts.map(a => ({ ...a, connected: connectedIds.has(a.id) })),
      threadsAccounts: threadsAccounts.map(a => ({ ...a, connected: connectedIds.has(a.id) })),
    };
  }));

  return NextResponse.json({ success: true, data: { configured: data.length > 0, connections: data } });
});

export const POST = withZernioManagement(async ({ workspaceId }, request) => {
  const { apiKey, label } = await readBody(request, keyBodySchema);
  await Promise.all([listProfiles(apiKey), listWebhooks(apiKey)]);
  await withConnectionLock(workspaceId, async tx => {
    // The same key twice would register a second webhook for the same
    // accounts, so it is refused.
    const encrypted = encryptToken(apiKey);
    if (await tx.zernioConnection.findFirst({ where: { workspaceId, apiKey: encrypted } }))
      throw new ConnectionError('This Zernio API key is already connected.', 409);
    await tx.zernioConnection.create({ data: { workspaceId, apiKey: encrypted, label: label?.trim() || null, webhookSecret: encryptToken(randomBytes(32).toString('hex')) } });
  });
  return NextResponse.json({ success: true });
});

export const PUT = withZernioManagement(async ({ workspaceId }, request) => {
  const { connectionId, profileId, label } = await readBody(request, profileBodySchema);
  await withConnectionLock(workspaceId, async tx => {
    const saved = await tx.zernioConnection.findFirst({ where: { id: connectionId, workspaceId } });
    if (!saved) throw new ConnectionError('Save your Zernio API key first.');
    const connection = { ...saved, apiKey: decryptToken(saved.apiKey) };
    if (!(await listProfiles(connection.apiKey)).some(p => p.id === profileId)) throw new ConnectionError('That profile is not accessible with this API key.', 403);
    // Moving a connection to another profile would orphan the accounts it
    // imported, so those have to go first.
    if (saved.profileId && saved.profileId !== profileId && await tx.socialAccount.count({ where: { zernioConnectionId: saved.id } })) {
      throw new ConnectionError('Disconnect this connection’s accounts before changing profile.');
    }
    const webhookId = await ensureWebhook({ apiKey: connection.apiKey, workspaceId, connectionId: saved.id, secret: decryptToken(connection.webhookSecret), baseUrl: getBaseUrl(), webhookId: connection.webhookId });
    await tx.zernioConnection.update({ where: { id: saved.id }, data: { profileId, webhookId, ...(label === undefined ? {} : { label: label.trim() || null }) } });
  });
  return NextResponse.json({ success: true });
});

export const DELETE = withZernioManagement(async ({ workspaceId }, request) => {
  const { connectionId } = await readBody(request, connectionBodySchema);
  await withConnectionLock(workspaceId, async tx => {
    const saved = await tx.zernioConnection.findFirst({ where: { id: connectionId, workspaceId } });
    if (!saved) throw new ConnectionError('Save your Zernio API key first.');
    const connection = { ...saved, apiKey: decryptToken(saved.apiKey) };
    if (await tx.socialAccount.count({ where: { zernioConnectionId: saved.id } })) throw new ConnectionError('Disconnect this connection’s accounts first.');
    const ours = (await listWebhooks(connection.apiKey)).find(w => w._id === connection.webhookId);
    if (ours) await zernioRequest({ apiKey: connection.apiKey, path: `/webhooks/settings?id=${encodeURIComponent(ours._id)}`, method: 'DELETE' });
    await tx.zernioConnection.delete({ where: { id: saved.id } });
  });
  return NextResponse.json({ success: true });
});
