import NextAuth, { type NextAuthConfig } from "next-auth";
import Nodemailer from "next-auth/providers/nodemailer";
import Postmark from "next-auth/providers/postmark";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser, getPrimaryWorkspace } from "@/lib/workspace";
import { isEmailAllowedToSignIn } from "@/lib/env";
import { getDevelopmentMagicLinkLogger } from "@/lib/auth-email";

type AdapterPrismaClient = Parameters<typeof PrismaAdapter>[0];

const emailFrom = process.env.EMAIL_FROM ?? "OpenReply <login@example.com>";
// Setting EMAIL_SERVER switches magic links to your own SMTP server, for
// self-hosters who do not want a third-party mail service. Resend is the
// default; set EMAIL_PROVIDER=postmark to use Postmark.
const smtpServer = process.env.EMAIL_SERVER;
const emailProvider = process.env.EMAIL_PROVIDER === "postmark" ? "postmark" : "resend";
const sendVerificationRequest = getDevelopmentMagicLinkLogger(
  process.env.NODE_ENV
);

/**
 * Provider id the login form has to sign in with. It differs per transport,
 * so it is derived here rather than hardcoded at the call site.
 */
export const EMAIL_PROVIDER_ID = smtpServer ? "nodemailer" : emailProvider;

export const authConfig = {
  adapter: PrismaAdapter(prisma as unknown as AdapterPrismaClient),
  providers: [
    smtpServer
      ? Nodemailer({
          server: smtpServer,
          from: emailFrom,
          ...(sendVerificationRequest ? { sendVerificationRequest } : {}),
        })
      : emailProvider === "postmark"
        ? Postmark({
            apiKey: process.env.AUTH_POSTMARK_KEY ?? "missing-postmark-server-token",
            from: emailFrom,
            ...(sendVerificationRequest ? { sendVerificationRequest } : {}),
          })
        : Resend({
            apiKey: process.env.RESEND_API_KEY ?? "missing-resend-api-key",
            from: emailFrom,
            ...(sendVerificationRequest ? { sendVerificationRequest } : {}),
          }),
  ],
  callbacks: {
    // Runs before the magic link is sent, so a blocked address never receives
    // one, and again when the link is verified.
    async signIn({ user }) {
      return isEmailAllowedToSignIn(user?.email);
    },
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (user.id) {
        await ensureWorkspaceForUser(user.id, user.email);
      }
    },
  },
  pages: {
    signIn: "/login",
    verifyRequest: "/verify-request",
  },
  session: {
    strategy: "database",
  },
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

export async function getCurrentWorkspaceId(): Promise<string | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;

  const workspace = await getPrimaryWorkspace(userId);
  if (workspace) return workspace.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  const createdWorkspace = await ensureWorkspaceForUser(userId, user?.email);
  return createdWorkspace.id;
}
