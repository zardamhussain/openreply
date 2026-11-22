import { NextResponse } from 'next/server';
import { z } from 'zod';
import { decryptToken } from '@/lib/meta/oauth';
import { withConnectionLock } from '@/lib/zernio/lock-connection';
import { loadConnection } from '@/lib/zernio/load-connection';
import { listZernioAccounts } from '@/lib/zernio/manage-remote';
import { ConnectionError, readBody, withZernioManagement } from '@/lib/zernio/route-handler';

const accountBodySchema = z.object({
  accountId: z.string().min(1),
  platform: z.enum(['instagram', 'threads']).optional().default('instagram'),
});

export const POST = withZernioManagement(async ({ workspaceId }, request) => {
  const { accountId, platform } = await readBody(request, accountBodySchema);
  const connection = await loadConnection(workspaceId);
  if (!connection.profileId || !connection.webhookId) throw new ConnectionError('Select a profile and finish webhook setup first.');
  const remote = (await listZernioAccounts({ apiKey: connection.apiKey, profileId: connection.profileId, platform })).find(a => a.id === accountId);
  if (!remote) throw new ConnectionError(`That ${platform === 'threads' ? 'Threads' : 'Instagram'} account is not in the selected profile.`, 403);
  await withConnectionLock(workspaceId, async tx => {
    const current = await tx.zernioConnection.findUnique({ where: { workspaceId } });
    if (!current || current.profileId !== connection.profileId || current.webhookId !== connection.webhookId || decryptToken(current.apiKey) !== connection.apiKey) throw new ConnectionError('Connection settings changed. Refresh and try again.');
    const socialPlatform = platform === 'threads' ? 'THREADS' : 'INSTAGRAM';
    const existing = await tx.socialAccount.findUnique({ where: { platform_platformUserId: { platform: socialPlatform, platformUserId: remote.platformUserId } } });
    if (existing && (existing.workspaceId !== workspaceId || existing.provider !== 'ZERNIO')) throw new ConnectionError('This account is already connected. Existing connections are not migrated automatically.', 409);
    const data = { username: remote.username, name: remote.name, zernioAccountId: remote.id, webhookSubscribed: true };
    if (existing) {
      const updated = await tx.socialAccount.updateMany({
        where: { id: existing.id, workspaceId, provider: 'ZERNIO' }, data,
      });
      if (!updated.count) throw new ConnectionError('This account connection changed. Refresh and try again.', 409);
    } else {
      await tx.socialAccount.create({ data: { ...data, workspaceId, platform: socialPlatform, platformUserId: remote.platformUserId, provider: 'ZERNIO', accessToken: '' } });
    }
  });
  return NextResponse.json({ success: true });
});
