import { describe, expect, it, vi } from "vitest";
import { getDevelopmentMagicLinkLogger } from "@/lib/auth-email";

describe("development magic-link logging", () => {
  it("logs the sign-in URL in development", () => {
    const log = vi.fn();
    const sendVerificationRequest = getDevelopmentMagicLinkLogger(
      "development",
      log
    );

    sendVerificationRequest?.({
      identifier: "person@example.com",
      url: "http://localhost:3000/api/auth/callback/resend?token=secret",
    });

    expect(log).toHaveBeenCalledWith(
      "OpenReply local sign-in link for person@example.com: http://localhost:3000/api/auth/callback/resend?token=secret"
    );
  });

  it("does not provide a logger outside development", () => {
    expect(getDevelopmentMagicLinkLogger("production")).toBeUndefined();
  });
});
