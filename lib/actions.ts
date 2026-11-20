"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentUserId, signOut } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/workspace";

export async function switchWorkspace(workspaceId: string) {
  const userId = await getCurrentUserId();
  if (!userId) return;

  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!membership) return;

  (await cookies()).set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  });
  revalidatePath("/", "layout");
}

export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
