import { handleZernioWebhook } from '@/lib/zernio/webhook-handler';

/**
 * The webhook URL a connection registered before the URL carried the
 * connection id. The signature still picks the right connection.
 */
export async function POST(
  request: Request,
  segmentData: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await segmentData.params;
  return handleZernioWebhook(request, workspaceId, null);
}
