/**
 * Threads webhook payload parsing — unit tests.
 *
 * Threads webhooks use a flat envelope, so these cases are built from the
 * documented payload shape rather than the Instagram one.
 */

import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  parseThreadsReplyEvents,
  verifyThreadsWebhookSignature,
} from "../lib/threads/webhook";

const REPLY_PAYLOAD = {
  app_id: "123456",
  topic: "moderate",
  target_id: "78901",
  time: 1723226877,
  subscription_id: "234567",
  has_uid_field: false,
  values: {
    value: {
      id: "8901234",
      username: "test_username",
      text: "Reply",
      media_type: "TEXT_POST",
      permalink: "https://www.threads.com/@test_username/post/Pp",
      replied_to: { id: "567890" },
      root_post: {
        id: "123456",
        owner_id: "123456",
        username: "test_username_2",
      },
      shortcode: "Pp",
      timestamp: "2024-08-07T10:33:16+0000",
    },
    field: "replies",
  },
};

describe("parseThreadsReplyEvents", () => {
  it("parses a reply event out of the documented payload", () => {
    const events = parseThreadsReplyEvents(REPLY_PAYLOAD);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      threadsUserId: "123456",
      replyId: "8901234",
      replyText: "Reply",
      replierUsername: "test_username",
      repliedToId: "567890",
      rootPostId: "123456",
      permalink: "https://www.threads.com/@test_username/post/Pp",
      timestamp: "2024-08-07T10:33:16+0000",
    });
  });

  it("ignores other topics and fields", () => {
    expect(
      parseThreadsReplyEvents({
        ...REPLY_PAYLOAD,
        topic: "interaction",
        values: { ...REPLY_PAYLOAD.values, field: "mentions" },
      })
    ).toEqual([]);
  });

  it("ignores a delete field", () => {
    expect(
      parseThreadsReplyEvents({
        ...REPLY_PAYLOAD,
        values: { ...REPLY_PAYLOAD.values, field: "delete" },
      })
    ).toEqual([]);
  });

  it("skips a reply with no id", () => {
    expect(
      parseThreadsReplyEvents({
        ...REPLY_PAYLOAD,
        values: {
          ...REPLY_PAYLOAD.values,
          value: {
            username: "test_username",
            text: "Reply",
            root_post: REPLY_PAYLOAD.values.value.root_post,
          },
        },
      })
    ).toEqual([]);
  });

  it("skips a reply whose root post has no owner id", () => {
    expect(
      parseThreadsReplyEvents({
        ...REPLY_PAYLOAD,
        values: {
          ...REPLY_PAYLOAD.values,
          value: {
            ...REPLY_PAYLOAD.values.value,
            root_post: { id: "123456", username: "test_username_2" },
          },
        },
      })
    ).toEqual([]);
  });

  it("defaults the reply text to an empty string", () => {
    const events = parseThreadsReplyEvents({
      ...REPLY_PAYLOAD,
      values: {
        ...REPLY_PAYLOAD.values,
        value: {
          id: REPLY_PAYLOAD.values.value.id,
          username: REPLY_PAYLOAD.values.value.username,
          root_post: REPLY_PAYLOAD.values.value.root_post,
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0].replyText).toBe("");
  });

  it("returns an empty list for junk input without throwing", () => {
    expect(parseThreadsReplyEvents(null)).toEqual([]);
    expect(parseThreadsReplyEvents(undefined)).toEqual([]);
    expect(parseThreadsReplyEvents({})).toEqual([]);
    expect(parseThreadsReplyEvents({ random: "object" })).toEqual([]);
    expect(parseThreadsReplyEvents("not an object")).toEqual([]);
    expect(parseThreadsReplyEvents(42)).toEqual([]);
    expect(parseThreadsReplyEvents([])).toEqual([]);
  });

  it("reads a notification whose values arrive as an array", () => {
    const events = parseThreadsReplyEvents({
      ...REPLY_PAYLOAD,
      values: [REPLY_PAYLOAD.values],
    });

    expect(events).toHaveLength(1);
    expect(events[0].replyId).toBe("8901234");
    expect(events[0].threadsUserId).toBe("123456");
  });

  it("keeps only the reply entries out of a mixed array", () => {
    const events = parseThreadsReplyEvents({
      ...REPLY_PAYLOAD,
      values: [
        { ...REPLY_PAYLOAD.values, field: "delete" },
        REPLY_PAYLOAD.values,
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0].replyId).toBe("8901234");
  });
});

describe("verifyThreadsWebhookSignature", () => {
  const secret = "threads-app-secret";

  function sign(body: string) {
    return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  }

  it("accepts a signature that matches the raw body", () => {
    const body = JSON.stringify(REPLY_PAYLOAD);
    expect(verifyThreadsWebhookSignature(body, sign(body), secret)).toBe(true);
  });

  it("rejects a body that was changed after signing", () => {
    const body = JSON.stringify(REPLY_PAYLOAD);
    expect(
      verifyThreadsWebhookSignature(`${body} `, sign(body), secret)
    ).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const body = JSON.stringify(REPLY_PAYLOAD);
    const other = `sha256=${createHmac("sha256", "other-secret")
      .update(body)
      .digest("hex")}`;
    expect(verifyThreadsWebhookSignature(body, other, secret)).toBe(false);
  });

  it("rejects a missing signature, a missing secret and a non-sha256 header", () => {
    const body = JSON.stringify(REPLY_PAYLOAD);
    expect(verifyThreadsWebhookSignature(body, null, secret)).toBe(false);
    expect(verifyThreadsWebhookSignature(body, sign(body), undefined)).toBe(
      false
    );
    expect(
      verifyThreadsWebhookSignature(
        body,
        `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`,
        secret
      )
    ).toBe(false);
  });
});
