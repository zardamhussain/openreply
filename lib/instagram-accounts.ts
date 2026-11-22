import { prisma } from "@/lib/db/client";

export async function canConnectInstagramAccount({
  workspaceId,
  instagramId,
}: {
  workspaceId: string;
  instagramId: string;
}) {
  const existingAccount = await prisma.socialAccount.findUnique({
    where: { platform_platformUserId: { platform: "INSTAGRAM", platformUserId: instagramId } },
    select: { workspaceId: true, provider: true },
  });

  if (existingAccount && (existingAccount.workspaceId !== workspaceId || existingAccount.provider === "ZERNIO")) {
    return {
      allowed: false,
      reason: "already_connected" as const,
    };
  }

  return {
    allowed: true,
    reason: null,
  };
}

export async function getWorkspaceInstagramAccount(
  workspaceId: string,
  instagramAccountId?: string | null
) {
  if (instagramAccountId && instagramAccountId !== "all") {
    return prisma.socialAccount.findFirst({
      where: { id: instagramAccountId, workspaceId, platform: "INSTAGRAM" },
    });
  }

  return prisma.socialAccount.findFirst({
    where: { workspaceId, platform: "INSTAGRAM" },
    orderBy: { connectedAt: "desc" },
  });
}

