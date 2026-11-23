import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    zernioConnection: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: (value: string) => `decrypted:${value}`,
}));

import { createZernioContext } from "@/lib/zernio/context";

const ACCOUNT = {
  workspaceId: "workspace_1",
  zernioAccountId: "zernio_account_1",
  zernioConnectionId: "zc_1",
  platform: "threads" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.zernioConnection.findUnique.mockResolvedValue({
    apiKey: "encrypted",
    workspaceId: "workspace_1",
  });
});

describe("Zernio account context", () => {
  it("resolves the credential through the account's own connection", async () => {
    const context = await createZernioContext(ACCOUNT);

    expect(context).toEqual({
      provider: "ZERNIO",
      apiKey: "decrypted:encrypted",
      accountId: "zernio_account_1",
      platform: "threads",
    });
    expect(mockPrisma.zernioConnection.findUnique).toHaveBeenCalledWith({
      where: { id: "zc_1" },
      select: { apiKey: true, workspaceId: true },
    });
  });

  it("refuses a connection that belongs to another workspace", async () => {
    mockPrisma.zernioConnection.findUnique.mockResolvedValue({
      apiKey: "encrypted",
      workspaceId: "workspace_other",
    });

    await expect(createZernioContext(ACCOUNT)).rejects.toThrow(
      "Zernio connection is not in this workspace"
    );
  });

  it("refuses an account that was never linked to a connection", async () => {
    await expect(
      createZernioContext({ ...ACCOUNT, zernioConnectionId: null })
    ).rejects.toThrow("Zernio connection is missing");
  });

  it("refuses an account with no Zernio account id", async () => {
    await expect(
      createZernioContext({ ...ACCOUNT, zernioAccountId: null })
    ).rejects.toThrow("Zernio account is not connected");
  });
});
