import { z } from 'zod';
import { zernioRequest } from './client';

const profilesSchema = z.object({ profiles: z.array(z.object({ _id: z.string(), name: z.string() })) });
const accountsSchema = z.object({ accounts: z.array(z.object({
  _id: z.string(), platform: z.string(), profileId: z.union([z.string(), z.object({ _id: z.string() })]),
  platformUserId: z.string().optional(), username: z.string(), displayName: z.string().nullish(), isActive: z.boolean().optional(),
})) });
const webhooksSchema = z.object({ webhooks: z.array(z.object({ _id: z.string(), url: z.string() })) });
const EVENTS = ['comment.received', 'message.received', 'message.read'];

export async function listProfiles(apiKey: string) {
  const data = profilesSchema.parse(await zernioRequest({ apiKey, path: '/profiles' }));
  return data.profiles.map(p => ({ id: p._id, name: p.name }));
}

/** The platforms OpenReply reads accounts for through Zernio. */
export type ZernioPlatform = 'instagram' | 'threads';

export type ZernioRemoteAccount = {
  id: string;
  platformUserId: string;
  username: string;
  name: string | null;
};

/**
 * The accounts of a Zernio profile on one platform.
 *
 * Zernio serves Instagram and Threads accounts the same way, so one call
 * covers both. `platformUserId` is the platform's own id for the account: the
 * Instagram id for Instagram, the Threads user id for Threads.
 */
export async function listZernioAccounts({ apiKey, profileId, platform }: { apiKey: string; profileId: string; platform: ZernioPlatform }): Promise<ZernioRemoteAccount[]> {
  const data = accountsSchema.parse(await zernioRequest({ apiKey, path: `/accounts?profileId=${encodeURIComponent(profileId)}&platform=${platform}` }));
  return data.accounts.filter(a => a.platform === platform && a.isActive !== false && a.platformUserId && (typeof a.profileId === 'string' ? a.profileId : a.profileId._id) === profileId)
    .map(a => ({ id: a._id, platformUserId: a.platformUserId!, username: a.username, name: a.displayName ?? null }));
}

export async function listInstagramAccounts({ apiKey, profileId }: { apiKey: string; profileId: string }) {
  return listZernioAccounts({ apiKey, profileId, platform: 'instagram' });
}

export async function listThreadsAccounts({ apiKey, profileId }: { apiKey: string; profileId: string }) {
  return listZernioAccounts({ apiKey, profileId, platform: 'threads' });
}

export async function listWebhooks(apiKey: string) {
  return webhooksSchema.parse(await zernioRequest({ apiKey, path: '/webhooks/settings' })).webhooks;
}

export function webhookUrl({ baseUrl, workspaceId }: { baseUrl: string; workspaceId: string }) {
  return new URL(`/api/zernio/webhook/${encodeURIComponent(workspaceId)}`, baseUrl).toString();
}

export async function ensureWebhook({ apiKey, workspaceId, secret, baseUrl, webhookId }: {
  apiKey: string; workspaceId: string; secret: string; baseUrl: string; webhookId?: string | null;
}) {
  const url = webhookUrl({ baseUrl, workspaceId });
  const webhooks = await listWebhooks(apiKey);
  const existing = webhooks.find(w => w._id === webhookId) ?? webhooks.find(w => w.url === url);
  const body = { name: 'OpenReply', url, secret, events: EVENTS, isActive: true };
  if (existing) {
    await zernioRequest({ apiKey, path: '/webhooks/settings', method: 'PUT', body: { ...body, _id: existing._id } });
    return existing._id;
  }
  const result = z.object({ webhook: z.object({ _id: z.string() }) }).parse(
    await zernioRequest({ apiKey, path: '/webhooks/settings', method: 'POST', body }),
  );
  return result.webhook._id;
}
