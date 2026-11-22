import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { processThreadsWebhook } from "@/lib/threads/process-webhook";
import {
  parseThreadsReplyEvents,
  verifyThreadsWebhookSignature,
} from "@/lib/threads/webhook";

/**
 * Threads webhook endpoint.
 *
 * Meta verifies the endpoint when the callback URL is saved, then sends every
 * notification as a signed POST. The signature is keyed with the **Threads**
 * app secret, which is a different secret from the Meta app secret.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (
    mode === "subscribe" &&
    token &&
    token === process.env.THREADS_VERIFY_TOKEN
  ) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json(
    { success: false, error: "Verification failed" },
    { status: 403 }
  );
}

export async function POST(request: NextRequest) {
  // The signature covers the raw body, so it has to be read before parsing.
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (
    !verifyThreadsWebhookSignature(
      rawBody,
      signature,
      process.env.THREADS_APP_SECRET
    )
  ) {
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "WARNING",
          message: "Threads webhook signature verification failed",
          payload: {
            hadSignatureHeader: Boolean(signature),
            bodyLength: rawBody.length,
          },
        },
      })
      .catch(() => {});
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 }
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  // A notification that carries no reply we can act on is still a valid
  // delivery, so it is acknowledged rather than retried.
  if (parseThreadsReplyEvents(payload).length === 0) {
    return NextResponse.json({ success: true, ignored: true });
  }

  try {
    await processThreadsWebhook({ payload });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { success: false, error: "Webhook processing failed; retry delivery." },
      { status: 500 }
    );
  }
}
