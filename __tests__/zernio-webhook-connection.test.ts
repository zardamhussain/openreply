import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockProcessInstagramWebhook, mockEnqueueThreadsReplyEvents } =
  vi.hoisted(() => ({
    mockPrisma: {
      zernioConnection: { findMany: vi.fn(), findFirst: vi.fn() },
      socialAccount: { findFirst: vi.fn() },
    },
    mockProcessInstagramWebhook: vi.fn(),
    mockEnqueueThreadsReplyEvents: vi.fn(),
  }));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: (value: string) => value,
}));

vi.mock("@/lib/queue/process-webhook", () => ({
  processInstagramWebhook: mockProcessInstagramWebhook,
}));

vi.mock("@/lib/threads/process-webhook", () => ({
  enqueueThreadsReplyEvents: mockEnqueueThreadsReplyEvents,
}));

import { handleZernioWebhook } from "@/lib/zernio/webhook-handler";

const BODY = JSON.stringify({
  id: "evt_1",
  event: "comment.received",
  account: { id: "zernio_account_1", platform: "instagram" },
  comment: {
    id: "comment_1",
    platformPostId: "post_1",
    text: "LINK",
    author: { id: "person_1", username: "reader" },
  },
});

function signed(secret: string) {
  return createHmac("sha256", secret).update(BODY).digest("hex");
}

function request(signature: string | null) {
  return new Request("https://open.example/api/zernio/webhook/ws", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(signature ? { "x-zernio-signature": signature } : {}),
    },
    body: BODY,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.zernioConnection.findMany.mockResolvedValue([]);
  mockPrisma.zernioConnection.findFirst.mockResolvedValue(null);
  mockPrisma.socialAccount.findFirst.mockResolvedValue(null);
});

describe("Zernio webhook connection selection", () => {
  it("picks the connection whose secret signed the request", async () => {
    mockPrisma.zernioConnection.findMany.mockResolvedValue([
      { id: "zc_1", workspaceId: "ws", webhookId: "hook_1", webhookSecret: "secret_one" },
      { id: "zc_2", workspaceId: "ws", webhookId: "hook_2", webhookSecret: "secret_two" },
    ]);
    mockPrisma.socialAccount.findFirst.mockResolvedValue({
      id: "account_row_1",
      platform: "INSTAGRAM",
      platformUserId: "ig_1",
      username: "ours",
      zernioAccountId: "zernio_account_1",
    });

    const response = await handleZernioWebhook(
      request(signed("secret_two")),
      "ws",
      null
    );

    expect(response.status).toBe(200);
    // Only the second connection's account can answer the request.
    expect(mockPrisma.socialAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ zernioConnectionId: "zc_2" }),
      })
    );
    expect(mockProcessInstagramWebhook).toHaveBeenCalled();
  });

  it("rejects a request that no connection signed", async () => {
    mockPrisma.zernioConnection.findMany.mockResolvedValue([
      { id: "zc_1", workspaceId: "ws", webhookId: "hook_1", webhookSecret: "secret_one" },
    ]);

    const response = await handleZernioWebhook(request(signed("wrong")), "ws", null);

    expect(response.status).toBe(401);
    expect(mockProcessInstagramWebhook).not.toHaveBeenCalled();
  });

  it("rejects a request with no signature at all", async () => {
    mockPrisma.zernioConnection.findMany.mockResolvedValue([
      { id: "zc_1", workspaceId: "ws", webhookId: "hook_1", webhookSecret: "secret_one" },
    ]);

    const response = await handleZernioWebhook(request(null), "ws", null);

    expect(response.status).toBe(401);
  });

  it("answers a workspace with no connection at all", async () => {
    const response = await handleZernioWebhook(request(signed("x")), "ws", null);

    expect(response.status).toBe(404);
  });

  it("uses the connection named in the URL", async () => {
    mockPrisma.zernioConnection.findFirst.mockResolvedValue({
      id: "zc_1",
      workspaceId: "ws",
      webhookId: "hook_1",
      webhookSecret: "secret_one",
    });

    const response = await handleZernioWebhook(
      request(signed("secret_one")),
      "ws",
      "zc_1"
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.zernioConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "zc_1", workspaceId: "ws" },
      })
    );
    // The account must belong to the connection the URL named.
    expect(mockPrisma.socialAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ zernioConnectionId: "zc_1" }),
      })
    );
  });
});
