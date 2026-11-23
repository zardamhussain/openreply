import { prisma } from '@/lib/db/client';
import { decryptToken } from '@/lib/meta/oauth';
import { ConnectionError } from './route-handler';

export async function loadConnection(workspaceId: string, connectionId: string) {
  const connection = await prisma.zernioConnection.findFirst({ where: { id: connectionId, workspaceId } });
  if (!connection) throw new ConnectionError('Save your Zernio API key first.');
  return { ...connection, apiKey: decryptToken(connection.apiKey) };
}
