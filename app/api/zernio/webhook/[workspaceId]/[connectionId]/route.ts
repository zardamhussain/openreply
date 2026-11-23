import { handleZernioWebhook } from '@/lib/zernio/webhook-handler';

export async function POST(
  request: Request,
  segmentData: { params: Promise<{ workspaceId: string; connectionId: string }> }
) {
  const { workspaceId, connectionId } = await segmentData.params;
  return handleZernioWebhook(request, workspaceId, connectionId);
}
