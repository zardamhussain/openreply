import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  mockCreateContainer,
  mockPublish,
  mockDecryptToken,
  mockMatchKeywords,
  mockReserveWorkspaceDMSend,
  mockReleaseWorkspaceDMReservation,
  mockZernioRequest,
  mockCreateZernioContext,
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
  mockZernioRequest: vi.fn(),
  mockCreateZernioContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));

vi.mock("@/lib/meta/client", () => ({
  MetaApiError: class MetaApiError extends Error {
    constructor(
      public code: number,
      public subcode: number | undefined,
      public fbTraceId: string | undefined,
      message: string
    ) {
      super(message);
      this.name = "MetaApiError";
    }
  },
}));

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

vi.mock("@/lib/zernio/client", () => ({
  zernioRequest: mockZernioRequest,
}));

vi.mock("@/lib/zernio/context", () => ({
  createZernioContext: mockCreateZernioContext,
}));

vi.mock("@/lib/utils/keyword-matcher", () => ({
  matchKeywords: mockMatchKeywords,
}));

vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mockReserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mockReleaseWorkspaceDMReservation,
}));

import { processThreadsReply } from "../lib/queue/threads-worker";
import { normalizeZernioThreadsEvent } from "../lib/zernio/normalize-event";

const ZERNIO_ACCOUNT = {
  id: "account_row_1",
  workspaceId: "workspace_1",
  username: "brand",
  accessToken: "",
  provider: "ZERNIO",
  zernioAccountId: "zernio_1",
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
  mockPrisma.socialAccount.findFirst.mockResolvedValue(ZERNIO_ACCOUNT);
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
  mockCreateZernioContext.mockResolvedValue({
    provider: "ZERNIO",
    apiKey: "zernio_key",
    accountId: "zernio_1",
    platform: "threads",
  });
  mockZernioRequest.mockResolvedValue({ data: { commentId: "reply_new" } });
});

describe("Threads replies through Zernio", () => {
  it("posts the reply to the comment through Zernio", async () => {
    await processThreadsReply(job());

    expect(mockZernioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "zernio_key",
        path: "/inbox/comments/post_1",
        method: "POST",
        body: {
          accountId: "zernio_1",
          commentId: "reply_1",
          message: expect.stringContaining("/r/abc123"),
        },
      })
    );
  });

  it("does not call the Meta Threads API for a Zernio account", async () => {
    await processThreadsReply(job());

    expect(mockCreateContainer).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("sends an idempotency key so a retry cannot publish twice", async () => {
    await processThreadsReply(job());

    expect(mockZernioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "threads-reply-zernio_1-reply_1",
      })
    );
  });

  it("records the delivery as sent", async () => {
    await processThreadsReply(job());

    expect(mockPrisma.deliveryLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "SENT",
          commentId: "reply_1",
        }),
      })
    );
  });

  it("records the failure when Zernio does not confirm the reply", async () => {
    mockZernioRequest.mockResolvedValue({});

    await expect(processThreadsReply(job())).rejects.toThrow(
      "Zernio did not confirm the Threads reply"
    );

    expect(mockPrisma.deliveryLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: "FAILED" }),
      })
    );
  });
});

describe("normalizeZernioThreadsEvent", () => {
  const account = {
    zernioAccountId: "zernio_1",
    platformUserId: "threads_user_1",
    username: "brand",
  };

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      id: "evt_1",
      event: "comment.received",
      account: { id: "zernio_1", platform: "threads" },
      comment: {
        id: "comment_1",
        platformPostId: "post_1",
        text: "I want the LINK",
        author: { id: "person_1", username: "reader" },
      },
      ...overrides,
    };
  }

  it("turns a Threads comment into a reply event", () => {
    expect(normalizeZernioThreadsEvent({ payload: payload(), account })).toEqual({
      replyId: "comment_1",
      replyText: "I want the LINK",
      replierUsername: "reader",
      rootPostId: "post_1",
    });
  });

  it("ignores an event for another account", () => {
    expect(
      normalizeZernioThreadsEvent({
        payload: payload({
          account: { id: "zernio_other", platform: "threads" },
        }),
        account,
      })
    ).toBeNull();
  });

  it("ignores an Instagram event", () => {
    expect(
      normalizeZernioThreadsEvent({
        payload: payload({
          account: { id: "zernio_1", platform: "instagram" },
        }),
        account,
      })
    ).toBeNull();
  });

  it("ignores the account's own comment", () => {
    expect(
      normalizeZernioThreadsEvent({
        payload: payload({
          comment: {
            id: "comment_1",
            platformPostId: "post_1",
            text: "mine",
            author: { id: "person_1", username: "brand" },
          },
        }),
        account,
      })
    ).toBeNull();
  });

  it("ignores an event that is not a comment", () => {
    expect(
      normalizeZernioThreadsEvent({
        payload: payload({ event: "message.received", comment: undefined }),
        account,
      })
    ).toBeNull();
  });
});
