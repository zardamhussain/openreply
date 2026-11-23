import { NextResponse } from 'next/server';
import { getBaseUrl } from '@/lib/env';
import { z } from 'zod';
import { loadConnection } from '@/lib/zernio/load-connection';
import { zernioRequest } from '@/lib/zernio/client';
import { ConnectionError, readOptionalBody, withZernioManagement } from '@/lib/zernio/route-handler';

const connectBodySchema = z.object({
  connectionId: z.string().min(1),
  platform: z.enum(['instagram', 'threads']).optional().default('instagram'),
});

export const POST = withZernioManagement(async ({ workspaceId }, request) => {
  const { connectionId, platform } = await readOptionalBody(request, connectBodySchema);
  const connection = await loadConnection(workspaceId, connectionId);
  if (!connection.profileId || !connection.webhookId) throw new ConnectionError('Select a profile and finish webhook setup first.');
  const params = new URLSearchParams({ profileId: connection.profileId, redirect_url: `${getBaseUrl()}/settings?zernio=connected` });
  const result = z.object({ authUrl: z.url() }).parse(await zernioRequest({ apiKey: connection.apiKey, path: `/connect/${platform}?${params}` }));
  const url = new URL(result.authUrl);
  if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com', 'facebook.com', 'www.facebook.com', 'threads.net', 'www.threads.net', 'zernio.com'].includes(url.hostname)) throw new ConnectionError('Zernio returned an unexpected connection URL.', 502);
  return NextResponse.json({ success: true, data: { authUrl: result.authUrl } });
});
