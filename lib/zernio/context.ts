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
  platform: "instagram" | "threads";
}): Promise<ZernioAccountContext> {
  if (!account.zernioAccountId)
    throw new Error("Zernio account is not connected");

  const connection = await prisma.zernioConnection.findUnique({
    where: { workspaceId: account.workspaceId },
    select: { apiKey: true },
  });
  if (!connection) throw new Error("Zernio workspace connection is missing");

  return {
    provider: "ZERNIO",
    apiKey: decryptToken(connection.apiKey),
    accountId: account.zernioAccountId,
    platform: account.platform,
  };
}
