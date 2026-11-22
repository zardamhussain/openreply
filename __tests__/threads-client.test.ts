/**
 * Threads API client — unit tests.
 *
 * The whole module talks to one host over `fetch`, so global fetch is
 * mocked and every case asserts on the request that was made.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ThreadsApiError,
  getThreadsUser,
  getThreadsUserPosts,
  getThreadsMediaReplies,
  createThreadsReplyContainer,
  publishThreadsContainer,
  getThreadsLongLivedToken,
  refreshThreadsAccessToken,
} from "../lib/threads/client";

const fetchMock = vi.fn();

function respond(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function lastUrl(): URL {
  return new URL(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("THREADS_APP_SECRET", "threads_app_secret");
});

describe("getThreadsUser", () => {
  it("parses the profile fields", async () => {
    respond({
      id: "777",
      username: "acme",
      name: "Acme Inc",
      threads_profile_picture_url: "https://cdn.example/pic.jpg",
    });

    const user = await getThreadsUser("token-123");

    expect(user).toEqual({
      id: "777",
      username: "acme",
      name: "Acme Inc",
      profilePictureUrl: "https://cdn.example/pic.jpg",
    });

    const url = lastUrl();
    expect(url.origin + url.pathname).toBe(
      "https://graph.threads.com/v1.0/me"
    );
    expect(url.searchParams.get("access_token")).toBe("token-123");
    expect(url.searchParams.get("fields")).toBe(
      "id,username,name,threads_profile_picture_url"
    );
  });

  it("leaves optional profile fields undefined when Threads omits them", async () => {
    respond({ id: "777", username: "acme" });

    const user = await getThreadsUser("token-123");

    expect(user.id).toBe("777");
    expect(user.username).toBe("acme");
    expect(user.name).toBeUndefined();
    expect(user.profilePictureUrl).toBeUndefined();
  });
});

describe("getThreadsUserPosts", () => {
  it("follows the after cursor across pages and stops at the end", async () => {
    respond({
      data: [{ id: "post_1", text: "first" }],
      paging: { cursors: { after: "CURSOR_1" } },
    });
    respond({
      data: [{ id: "post_2", text: "second" }],
    });

    const { posts, nextCursor } = await getThreadsUserPosts("token-123");

    expect(posts.map((p) => p.id)).toEqual(["post_1", "post_2"]);
    expect(posts[0].text).toBe("first");
    expect(nextCursor).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const first = new URL(fetchMock.mock.calls[0][0]);
    expect(first.pathname).toBe("/v1.0/me/threads");
    expect(first.searchParams.get("after")).toBeNull();

    const second = new URL(fetchMock.mock.calls[1][0]);
    expect(second.searchParams.get("after")).toBe("CURSOR_1");
    expect(second.searchParams.get("access_token")).toBe("token-123");
  });

  it("hands back the cursor when it stops at the page ceiling", async () => {
    for (let i = 0; i < 5; i++) {
      respond({
        data: [{ id: `post_${i}` }],
        paging: { cursors: { after: `CURSOR_${i}` } },
      });
    }

    const { posts, nextCursor } = await getThreadsUserPosts("token-123");

    expect(posts).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(nextCursor).toBe("CURSOR_4");
  });

  it("passes an explicit starting cursor through", async () => {
    respond({ data: [] });

    await getThreadsUserPosts("token-123", { after: "START_CURSOR", limit: 50 });

    const url = lastUrl();
    expect(url.searchParams.get("after")).toBe("START_CURSOR");
    expect(url.searchParams.get("limit")).toBe("50");
  });
});

describe("getThreadsMediaReplies", () => {
  it("maps the reply fields onto ThreadsReply", async () => {
    respond({
      data: [
        {
          id: "reply_1",
          text: "nice post",
          username: "commenter",
          permalink: "https://www.threads.com/@acme/post/abc",
          timestamp: "2024-08-07T10:33:16+0000",
          replied_to: { id: "media_9" },
          root_post: {
            id: "root_1",
            owner_id: "owner_1",
            username: "acme",
          },
          is_reply_owned_by_me: false,
          media_type: "TEXT",
          media_url: "https://cdn.example/media.jpg",
        },
      ],
    });

    const { replies, nextCursor } = await getThreadsMediaReplies(
      "token-123",
      "media_9"
    );

    expect(nextCursor).toBeUndefined();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual({
      id: "reply_1",
      text: "nice post",
      username: "commenter",
      permalink: "https://www.threads.com/@acme/post/abc",
      timestamp: "2024-08-07T10:33:16+0000",
      repliedToId: "media_9",
      rootPostId: "root_1",
      rootPostOwnerId: "owner_1",
      rootPostUsername: "acme",
      isReplyOwnedByMe: false,
      mediaType: "TEXT",
      mediaUrl: "https://cdn.example/media.jpg",
    });

    const url = lastUrl();
    expect(url.pathname).toBe("/v1.0/media_9/replies");
    expect(url.searchParams.get("access_token")).toBe("token-123");
  });

  it("aggregates replies across pages", async () => {
    respond({
      data: [{ id: "reply_1" }],
      paging: { cursors: { after: "CURSOR_1" } },
    });
    respond({ data: [{ id: "reply_2" }] });

    const { replies } = await getThreadsMediaReplies("token-123", "media_9");

    expect(replies.map((r) => r.id)).toEqual(["reply_1", "reply_2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new URL(fetchMock.mock.calls[1][0]).searchParams.get("after")
    ).toBe("CURSOR_1");
  });
});

describe("createThreadsReplyContainer", () => {
  it("posts the text container with the reply target", async () => {
    respond({ id: "container_1" });

    const result = await createThreadsReplyContainer("token-123", {
      replyToId: "media_9",
      text: "thanks!",
    });

    expect(result).toEqual({ id: "container_1" });

    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("https://graph.threads.com/v1.0/me/threads");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );

    const body = new URLSearchParams(call[1].body as string);
    expect(body.get("media_type")).toBe("TEXT");
    expect(body.get("text")).toBe("thanks!");
    expect(body.get("reply_to_id")).toBe("media_9");
    expect(body.get("access_token")).toBe("token-123");
  });
});

describe("publishThreadsContainer", () => {
  it("publishes the container under the account", async () => {
    respond({ id: "media_42" });

    const result = await publishThreadsContainer(
      "token-123",
      "user_1",
      "container_1"
    );

    expect(result).toEqual({ id: "media_42" });

    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe(
      "https://graph.threads.com/v1.0/user_1/threads_publish"
    );
    expect(call[1].method).toBe("POST");

    const body = new URLSearchParams(call[1].body as string);
    expect(body.get("creation_id")).toBe("container_1");
    expect(body.get("access_token")).toBe("token-123");
  });
});

describe("error handling", () => {
  it("turns a Graph error envelope into a ThreadsApiError", async () => {
    respond(
      {
        error: {
          message: "Invalid OAuth access token.",
          type: "OAuthException",
          code: 190,
          error_subcode: 463,
          fbtrace_id: "trace-abc",
        },
      },
      400
    );

    const error = await getThreadsUser("token-123").catch((e) => e);

    expect(error).toBeInstanceOf(ThreadsApiError);
    expect(error.name).toBe("ThreadsApiError");
    expect(error.code).toBe(190);
    expect(error.subcode).toBe(463);
    expect(error.fbTraceId).toBe("trace-abc");
    expect(error.message).toContain("Invalid OAuth access token.");
    expect(error.message).toContain("/me");
  });

  it("never puts the access token in the error message", async () => {
    respond(
      {
        error: {
          message: "Invalid OAuth access token.",
          type: "OAuthException",
          code: 190,
        },
      },
      400
    );

    const error = await getThreadsUser("super-secret-token").catch((e) => e);

    expect(error).toBeInstanceOf(ThreadsApiError);
    expect(error.message).not.toContain("super-secret-token");
  });

  it("falls back to the HTTP status when the body carries no error code", async () => {
    respond({ message: "boom" }, 500);

    const error = await getThreadsUser("token-123").catch((e) => e);

    expect(error).toBeInstanceOf(ThreadsApiError);
    expect(error.code).toBe(500);
  });
});

describe("getThreadsLongLivedToken", () => {
  it("exchanges the short-lived token", async () => {
    respond({
      access_token: "long-lived-token",
      access_token_type: "bearer",
      expires_in: 5183944,
    });

    const result = await getThreadsLongLivedToken("short-lived-token");

    expect(result).toEqual({
      accessToken: "long-lived-token",
      expiresIn: 5183944,
    });

    const url = lastUrl();
    expect(url.origin + url.pathname).toBe(
      "https://graph.threads.com/access_token"
    );
    expect(url.searchParams.get("grant_type")).toBe("th_exchange_token");
    expect(url.searchParams.get("access_token")).toBe("short-lived-token");
    expect(url.searchParams.get("client_secret")).toBe("threads_app_secret");
  });
});

describe("refreshThreadsAccessToken", () => {
  it("refreshes the long-lived token", async () => {
    respond({
      access_token: "refreshed-token",
      access_token_type: "bearer",
      expires_in: 5183944,
    });

    const result = await refreshThreadsAccessToken("long-lived-token");

    expect(result).toEqual({
      accessToken: "refreshed-token",
      expiresIn: 5183944,
    });

    const url = lastUrl();
    expect(url.origin + url.pathname).toBe(
      "https://graph.threads.com/refresh_access_token"
    );
    expect(url.searchParams.get("grant_type")).toBe("th_refresh_token");
    expect(url.searchParams.get("access_token")).toBe("long-lived-token");
  });
});
