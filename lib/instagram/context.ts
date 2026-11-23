import { decryptToken } from "@/lib/meta/oauth";
import { createZernioContext } from "@/lib/zernio/context";

export type InstagramContext =
  | { provider: "META"; accessToken: string }
  | {
      provider: "ZERNIO";
      apiKey: string;
      accountId: string;
      instagramId: string;
      operationId?: string;
    };

export type ProviderAccount = {
  provider: "META" | "ZERNIO";
  workspaceId: string;
  zernioAccountId: string | null;
  zernioConnectionId: string | null;
  platformUserId: string;
  accessToken: string;
};

export function hasInstagramCredentials(
  account: Pick<ProviderAccount, "provider" | "accessToken" | "zernioAccountId">
) {
  return account.provider === "ZERNIO"
    ? Boolean(account.zernioAccountId)
    : Boolean(account.accessToken);
}

export async function createInstagramContext(
  account: ProviderAccount,
  operationId?: string
): Promise<InstagramContext> {
  if (account.provider !== "ZERNIO")
    return { provider: "META", accessToken: decryptToken(account.accessToken) };
  const { apiKey, accountId } = await createZernioContext({
    workspaceId: account.workspaceId,
    zernioAccountId: account.zernioAccountId,
    zernioConnectionId: account.zernioConnectionId,
    platform: "instagram",
  });
  return {
    provider: "ZERNIO",
    apiKey,
    accountId,
    instagramId: account.platformUserId,
    ...(operationId ? { operationId } : {}),
  };
}

export type ZernioContext = Extract<InstagramContext, { provider: "ZERNIO" }>;
