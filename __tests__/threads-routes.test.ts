import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockPrisma,
  mockGetThreadsUserPosts,
  mockGetThreadsUser,
  mockCanManageWorkspace,
} = vi.hoisted(() => {
  const mockPrisma = {
    socialAccount: {
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  return {
    mockPrisma,
    mockGetThreadsUserPosts: vi.fn(),
    mockGetThreadsUser: vi.fn(),
    mockCanManageWorkspace: vi.fn(() => true),
  };
});

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentWorkspaceId: vi.fn(async () => "workspace_123"),
}));

vi.mock("@/lib/workspace-access", () => ({
  canManageWorkspace: () => mockCanManageWorkspace(),
  getCurrentWorkspaceContext: vi.fn(async () => ({
    workspaceId: "workspace_123",
    role: "OWNER",
  })),
}));

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: (token: string) => token,
}));

vi.mock("@/lib/threads/client", () => ({
  getThreadsUserPosts: mockGetThreadsUserPosts,
  getThreadsUser: mockGetThreadsUser,
}));

import { GET as getPosts } from "../app/api/threads/posts/route";
import { GET as getProfile } from "../app/api/threads/profile/route";
import { POST as disconnect } from "../app/api/threads/disconnect/route";

function get(url: string) {
  return new NextRequest(`https://example.com${url}`);
}

function post(body: unknown) {
  return new NextRequest("https://example.com/api/threads/disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCanManageWorkspace.mockReturnValue(true);
  mockPrisma.socialAccount.findFirst.mockResolvedValue({
    id: "account_123",
    accessToken: "encrypted-token",
  });
  mockPrisma.socialAccount.deleteMany.mockResolvedValue({ count: 1 });
  mockGetThreadsUserPosts.mockResolvedValue({
    posts: [
      {
        id: "post_1",
        text: "hello from threads",
        mediaType: "TEXT_POST",
        permalink: "https://www.threads.net/@user/post/post_1",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ],
  });
});

describe("GET /api/threads/posts", () => {
  it("returns posts in the shape the Instagram endpoint returns", async () => {
    const response = await getPosts(get("/api/threads/posts?socialAccountId=account_123"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual([
      {
        id: "post_1",
        caption: "hello from threads",
        media_type: "TEXT_POST",
        media_url: undefined,
        thumbnail_url: undefined,
        permalink: "https://www.threads.net/@user/post/post_1",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(body.limitations).toEqual([]);
  });

  it("scopes the lookup to the workspace and the Threads platform", async () => {
    await getPosts(get("/api/threads/posts?socialAccountId=account_123"));

    expect(mockPrisma.socialAccount.findFirst).toHaveBeenCalledWith({
      where: {
        id: "account_123",
        workspaceId: "workspace_123",
        platform: "THREADS",
      },
      select: {
        id: true,
        accessToken: true,
        provider: true,
        zernioAccountId: true,
      },
    });
  });

  it("refuses an account that is not in the workspace", async () => {
    mockPrisma.socialAccount.findFirst.mockResolvedValue(null);

    const response = await getPosts(get("/api/threads/posts?socialAccountId=other"));

    expect(response.status).toBe(404);
    expect(mockGetThreadsUserPosts).not.toHaveBeenCalled();
  });

  it("loads the whole library when the post picker asks for it", async () => {
    await getPosts(get("/api/threads/posts?socialAccountId=account_123&all=true"));

    expect(mockGetThreadsUserPosts).toHaveBeenCalledWith("encrypted-token", {
      limit: 100,
    });
  });
});

describe("GET /api/threads/profile", () => {
  it("returns the Threads profile of the workspace's account", async () => {
    mockGetThreadsUser.mockResolvedValue({
      id: "threads_user_1",
      username: "brand",
      name: "Brand",
      profilePictureUrl: "https://cdn.example.com/avatar.jpg",
    });

    const response = await getProfile(
      get("/api/threads/profile?socialAccountId=account_123")
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({
      username: "brand",
      name: "Brand",
      profilePictureUrl: "https://cdn.example.com/avatar.jpg",
    });
  });

  it("scopes the lookup to the workspace and the Threads platform", async () => {
    await getProfile(get("/api/threads/profile?socialAccountId=account_123"));

    expect(mockPrisma.socialAccount.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_123",
        platform: "THREADS",
        id: "account_123",
      },
      orderBy: { connectedAt: "desc" },
      select: {
        id: true,
        accessToken: true,
        provider: true,
        zernioAccountId: true,
      },
    });
  });

  it("refuses when the workspace has no Threads account", async () => {
    mockPrisma.socialAccount.findFirst.mockResolvedValue(null);

    const response = await getProfile(get("/api/threads/profile"));

    expect(response.status).toBe(400);
    expect(mockGetThreadsUser).not.toHaveBeenCalled();
  });
});

describe("POST /api/threads/disconnect", () => {
  it("deletes only the workspace's Threads account", async () => {
    const response = await disconnect(post({ socialAccountId: "account_123" }));

    expect(response.status).toBe(200);
    expect(mockPrisma.socialAccount.deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_123",
        platform: "THREADS",
        id: "account_123",
      },
    });
  });

  it("never deletes an Instagram account", async () => {
    await disconnect(post({ socialAccountId: "account_123" }));

    const where = mockPrisma.socialAccount.deleteMany.mock.calls[0][0].where;
    expect(where.platform).toBe("THREADS");
  });

  it("refuses a member who cannot manage the workspace", async () => {
    mockCanManageWorkspace.mockReturnValue(false);

    const response = await disconnect(post({ socialAccountId: "account_123" }));

    expect(response.status).toBe(403);
    expect(mockPrisma.socialAccount.deleteMany).not.toHaveBeenCalled();
  });
});
