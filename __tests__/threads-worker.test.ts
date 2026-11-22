import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrisma,
  mockCreateContainer,
  mockPublish,
  mockDecryptToken,
  mockMatchKeywords,
  mockReserveWorkspaceDMSend,
  mockReleaseWorkspaceDMReservation,
} = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findMany: vi.fn() },
    deliveryLog: { findUnique: vi.fn(), upsert: vi.fn() },
    socialAccount: { findFirst: vi.fn() },
  },
  mockCreateContainer: vi.fn(),
  mockPublish: vi.fn(),
  mockDecryptToken: vi.fn(),
  mockMatchKeywords: vi.fn(),
  mockReserveWorkspaceDMSend: vi.fn(),
  mockReleaseWorkspaceDMReservation: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));

vi.mock("@/lib/threads/client", () => ({
  createThreadsReplyContainer: mockCreateContainer,
  publishThreadsContainer: mockPublish,
  ThreadsApiError: class ThreadsApiError extends Error {
    code: number;
    constructor(
      code: number,
      _subcode: number | undefined,
      _fbTraceId: string | undefined,
      message: string
    ) {
      super(message);
      this.code = code;
      this.name = "ThreadsApiError";
    }
  },
}));

vi.mock("@/lib/utils/keyword-matcher", () => ({
  matchKeywords: mockMatchKeywords,
}));

vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mockReserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mockReleaseWorkspaceDMReservation,
}));

import { processThreadsReply } from "../lib/queue/threads-worker";

const ACCOUNT = {
  id: "account_row_1",
  workspaceId: "workspace_1",
  username: "brand",
  accessToken: "encrypted",
};

const CAMPAIGN = {
  id: "automation_1",
  workspaceId: "workspace_1",
  socialAccountId: "account_row_1",
  dmMessage: "Here is the link {link}",
  matchAnyWord: false,
  keywords: ["LINK"],
  wholeWordMatch: true,
  trackedLinks: [{ slug: "abc123", destinationUrl: "https://example.com" }],
};

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_1",
    name: "process-threads-reply",
    attemptsMade: 0,
    data: {
      threadsUserId: "threads_user_1",
      accountConnectionId: "account_row_1",
      replyId: "reply_1",
      replyText: "I want the LINK",
      replierUsername: "reader",
      rootPostId: "post_1",
      ...overrides,
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.socialAccount.findFirst.mockResolvedValue(ACCOUNT);
  mockPrisma.automation.findMany.mockResolvedValue([CAMPAIGN]);
  mockPrisma.deliveryLog.findUnique.mockResolvedValue(null);
  mockPrisma.deliveryLog.upsert.mockResolvedValue({});
  mockDecryptToken.mockReturnValue("plain_token");
  mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
  mockReserveWorkspaceDMSend.mockResolvedValue({
    allowed: true,
    reserved: true,
    remaining: 99,
    limit: 100,
    periodStart: new Date(),
  });
  mockCreateContainer.mockResolvedValue({ id: "container_1" });
  mockPublish.mockResolvedValue({ id: "published_1" });
});

describe("Threads reply delivery", () => {
  it("publishes the campaign message as a reply to the comment", async () => {
    await processThreadsReply(job());

    // The destination URL is replaced by the tracked redirect, which is what
    // makes the click attributable to this campaign.
    expect(mockCreateContainer).toHaveBeenCalledWith("plain_token", {
      replyToId: "reply_1",
      text: expect.stringContaining("/r/abc123"),
    });
    expect(mockPublish).toHaveBeenCalledWith(
      "plain_token",
      "threads_user_1",
      "container_1"
    );
  });

  it("records the delivery as sent", async () => {
    await processThreadsReply(job());

    expect(mockPrisma.deliveryLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "SENT",
          commentId: "reply_1",
          socialAccountId: "account_row_1",
        }),
      })
    );
  });

  it("does nothing when no campaign matches the post", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);

    await processThreadsReply(job());

    expect(mockCreateContainer).not.toHaveBeenCalled();
    expect(mockPrisma.deliveryLog.upsert).not.toHaveBeenCalled();
  });

  it("does nothing when the keywords do not match", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });

    await processThreadsReply(job());

    expect(mockCreateContainer).not.toHaveBeenCalled();
  });

  it("does not answer the account's own reply", async () => {
    await processThreadsReply(job({ replierUsername: "BRAND" }));

    expect(mockCreateContainer).not.toHaveBeenCalled();
  });

  it("does not publish twice when the reply was already sent", async () => {
    mockPrisma.deliveryLog.findUnique.mockResolvedValue({
      status: "SENT",
      attempts: 1,
      deliveryUnconfirmed: false,
    });

    await processThreadsReply(job());

    expect(mockCreateContainer).not.toHaveBeenCalled();
  });

  it("does not retry a reply whose delivery was left unconfirmed", async () => {
    mockPrisma.deliveryLog.findUnique.mockResolvedValue({
      status: "FAILED",
      attempts: 1,
      deliveryUnconfirmed: true,
    });

    await processThreadsReply(job());

    expect(mockCreateContainer).not.toHaveBeenCalled();
  });

  it("stops after the attempt budget is used up", async () => {
    mockPrisma.deliveryLog.findUnique.mockResolvedValue({
      status: "FAILED",
      attempts: 3,
      deliveryUnconfirmed: false,
    });

    await processThreadsReply(job());

    expect(mockCreateContainer).not.toHaveBeenCalled();
  });

  it("records a failed delivery and rethrows", async () => {
    mockPublish.mockRejectedValue(new Error("Threads is down"));

    await expect(processThreadsReply(job())).rejects.toThrow("Threads is down");

    expect(mockPrisma.deliveryLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: "FAILED" }),
      })
    );
  });

  it("gives the workspace allowance back when the reply was never delivered", async () => {
    mockPublish.mockRejectedValue(new Error("Threads is down"));

    await expect(processThreadsReply(job())).rejects.toThrow("Threads is down");

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_1",
      expect.any(Date)
    );
  });

  it("skips the reply when the workspace limit is reached", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 100,
      periodStart: new Date(),
    });

    await processThreadsReply(job());

    expect(mockCreateContainer).not.toHaveBeenCalled();
    expect(mockPrisma.deliveryLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
      })
    );
  });

  it("marks an unrecoverable failure so it is not retried", async () => {
    const { ThreadsApiError } = await import("@/lib/threads/client");
    mockPublish.mockRejectedValue(
      new ThreadsApiError(190, undefined, undefined, "Invalid OAuth token")
    );

    await expect(processThreadsReply(job())).rejects.toThrow(
      "Invalid OAuth token"
    );

    expect(mockPrisma.deliveryLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ deliveryUnconfirmed: true }),
      })
    );
  });

  it("puts the tracked link in the reply text when the message has no link token", async () => {
    // A Threads reply has no button, so the link has to ride in the text.
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...CAMPAIGN, dmMessage: "Here is the offer" },
    ]);

    await processThreadsReply(job());

    expect(mockCreateContainer).toHaveBeenCalledWith("plain_token", {
      replyToId: "reply_1",
      text: expect.stringContaining("/r/abc123"),
    });
  });

  it("does not repeat the tracked link when the message already carries it", async () => {
    await processThreadsReply(job());

    const text = mockCreateContainer.mock.calls[0][1].text as string;
    expect(text.match(/\/r\/abc123/g)).toHaveLength(1);
  });
});
