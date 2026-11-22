-- Platform-neutral accounts and delivery logs.
--
-- One account table now holds both Instagram and Threads accounts, discriminated
-- by "platform". One delivery log holds both private-DM outcomes (Instagram)
-- and published-reply outcomes (Threads).
--
-- Renames preserve existing rows and keep their ids, so no data is rewritten.
-- "instagramId" becomes "platformUserId" because the column now stores the
-- account id on whichever platform the row belongs to: the Instagram
-- professional account id on Instagram, the app-scoped user id on Threads.

ALTER TABLE "InstagramAccount" RENAME TO "SocialAccount";
ALTER TABLE "SocialAccount" RENAME COLUMN "instagramId" TO "platformUserId";
ALTER TABLE "DmLog" RENAME TO "DeliveryLog";
ALTER TABLE "DeliveryLog" RENAME COLUMN "dmSentAt" TO "sentAt";
ALTER TABLE "DeliveryLog" RENAME COLUMN "dmDeliveryUnconfirmed" TO "deliveryUnconfirmed";
ALTER TABLE "Automation" RENAME COLUMN "instagramAccountId" TO "socialAccountId";
ALTER TABLE "DeliveryLog" RENAME COLUMN "instagramAccountId" TO "socialAccountId";
ALTER TABLE "LinkClick" RENAME COLUMN "instagramAccountId" TO "socialAccountId";
ALTER TABLE "FollowerSnapshot" RENAME COLUMN "instagramAccountId" TO "socialAccountId";
ALTER TABLE "ProcessedComment" RENAME COLUMN "instagramAccountId" TO "socialAccountId";

-- The enums are renamed in place so existing rows keep their values.
ALTER TYPE "InstagramProvider" RENAME TO "AccountProvider";
ALTER TYPE "DmStatus" RENAME TO "DeliveryStatus";

-- Platform discriminator. Every existing account is an Instagram account.
CREATE TYPE "SocialPlatform" AS ENUM ('INSTAGRAM', 'THREADS');
ALTER TABLE "SocialAccount" ADD COLUMN "platform" "SocialPlatform" NOT NULL DEFAULT 'INSTAGRAM';

-- Identity is per platform: an Instagram id and a Threads id can collide, so
-- the old global unique index on "instagramId" is replaced by a composite one.
DROP INDEX "InstagramAccount_instagramId_key";
CREATE UNIQUE INDEX "SocialAccount_platform_platformUserId_key" ON "SocialAccount"("platform", "platformUserId");

-- Index and constraint names follow the renamed tables and columns.
ALTER INDEX "InstagramAccount_workspaceId_idx" RENAME TO "SocialAccount_workspaceId_idx";
ALTER INDEX "Automation_instagramAccountId_idx" RENAME TO "Automation_socialAccountId_idx";
ALTER INDEX "DmLog_automationId_commentId_key" RENAME TO "DeliveryLog_automationId_commentId_key";
ALTER INDEX "DmLog_automationId_idx" RENAME TO "DeliveryLog_automationId_idx";
ALTER INDEX "DmLog_instagramAccountId_idx" RENAME TO "DeliveryLog_socialAccountId_idx";
ALTER INDEX "DmLog_status_idx" RENAME TO "DeliveryLog_status_idx";
ALTER INDEX "DmLog_workspaceId_idx" RENAME TO "DeliveryLog_workspaceId_idx";
ALTER INDEX "LinkClick_instagramAccountId_idx" RENAME TO "LinkClick_socialAccountId_idx";
ALTER INDEX "FollowerSnapshot_instagramAccountId_date_idx" RENAME TO "FollowerSnapshot_socialAccountId_date_idx";
ALTER INDEX "FollowerSnapshot_instagramAccountId_date_key" RENAME TO "FollowerSnapshot_socialAccountId_date_key";
ALTER INDEX "ProcessedComment_instagramAccountId_idx" RENAME TO "ProcessedComment_socialAccountId_idx";
