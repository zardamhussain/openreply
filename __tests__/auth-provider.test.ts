import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  default: () => ({
    handlers: {},
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("authentication email provider", () => {
  it("keeps Resend as the default provider", async () => {
    vi.stubEnv("EMAIL_SERVER", "");
    vi.stubEnv("EMAIL_PROVIDER", "");
    vi.stubEnv("RESEND_API_KEY", "resend-test-token");
    vi.resetModules();

    const { authConfig, EMAIL_PROVIDER_ID } = await import("@/lib/auth");

    expect(EMAIL_PROVIDER_ID).toBe("resend");
    expect(authConfig.providers[0]).toMatchObject({
      id: "resend",
      options: { apiKey: "resend-test-token" },
    });
  });

  it("uses Postmark when selected", async () => {
    vi.stubEnv("EMAIL_SERVER", "");
    vi.stubEnv("EMAIL_PROVIDER", "postmark");
    vi.stubEnv("AUTH_POSTMARK_KEY", "postmark-test-token");
    vi.resetModules();

    const { authConfig, EMAIL_PROVIDER_ID } = await import("@/lib/auth");

    expect(EMAIL_PROVIDER_ID).toBe("postmark");
    expect(authConfig.providers[0]).toMatchObject({
      id: "postmark",
      options: { apiKey: "postmark-test-token" },
    });
  });
});
