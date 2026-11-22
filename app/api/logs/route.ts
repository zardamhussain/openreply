import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { DeliveryStatus } from "@/app/generated/prisma/client";

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(
    50,
    Math.max(1, Number.parseInt(searchParams.get("limit") ?? "20", 10))
  );
  const status = searchParams.get("status");
  const socialAccountId = searchParams.get("socialAccountId");
  const skip = (page - 1) * limit;
  const parsedStatus =
    status && Object.values(DeliveryStatus).includes(status as DeliveryStatus)
      ? (status as DeliveryStatus)
      : null;

  const where = {
    workspaceId,
    ...(parsedStatus ? { status: parsedStatus } : {}),
    ...(socialAccountId && socialAccountId !== "all"
      ? { socialAccountId }
      : {}),
  };

  const [logs, total] = await Promise.all([
    prisma.deliveryLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      include: {
        automation: { select: { name: true, keywords: true } },
        socialAccount: { select: { username: true } },
      },
    }),
    prisma.deliveryLog.count({ where }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    },
  });
}
