import { decryptToken } from "@/lib/meta/oauth";
import { prisma } from "@/lib/db/client";

/**
 * The credentials a Zernio call needs.
 *
 * Zernio holds the platform credentials, so OpenReply never stores a Meta
 * access token for a Zernio-connected account. The API key belongs to the
 * workspace, and the account id is the Zernio account that answers.
 */
export type ZernioAccountContext = {
  provider: "ZERNIO";
  apiKey: string;
  accountId: string;
  platform: "instagram" | "threads";
};

export async function createZernioContext(account: {
  workspaceId: string;
  zernioAccountId: string | null;
  zernioConnectionId: string | null;
  platform: "instagram" | "threads";
}): Promise<ZernioAccountContext> {
  if (!account.zernioAccountId)
    throw new Error("Zernio account is not connected");
  if (!account.zernioConnectionId)
    throw new Error("Zernio connection is missing");

  const connection = await prisma.zernioConnection.findUnique({
    where: { id: account.zernioConnectionId },
    select: { apiKey: true, workspaceId: true },
  });
  if (!connection) throw new Error("Zernio connection is missing");
  // A connection belongs to one workspace, so an account pointing at another
  // workspace's connection is not this account's business.
  if (connection.workspaceId !== account.workspaceId)
    throw new Error("Zernio connection is not in this workspace");

  return {
    provider: "ZERNIO",
    apiKey: decryptToken(connection.apiKey),
    accountId: account.zernioAccountId,
    platform: account.platform,
  };
}
