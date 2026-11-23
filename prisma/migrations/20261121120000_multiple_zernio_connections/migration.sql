-- Allow a workspace to hold more than one Zernio connection.
--
-- A connection used to be keyed by workspace, so one API key per workspace.
-- Now each connection has its own id, and a Zernio account records the
-- connection that imported it, so the right API key answers for it.

-- Every connection gets its own id.
ALTER TABLE "ZernioConnection" ADD COLUMN "id" TEXT;
UPDATE "ZernioConnection"
SET "id" = md5(random()::text || clock_timestamp()::text)
WHERE "id" IS NULL;
ALTER TABLE "ZernioConnection" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "ZernioConnection" DROP CONSTRAINT "ZernioConnection_pkey";
ALTER TABLE "ZernioConnection" ADD CONSTRAINT "ZernioConnection_pkey" PRIMARY KEY ("id");
CREATE INDEX "ZernioConnection_workspaceId_idx" ON "ZernioConnection"("workspaceId");

-- A Zernio account belongs to the connection that imported it.
ALTER TABLE "SocialAccount" ADD COLUMN "zernioConnectionId" TEXT;
UPDATE "SocialAccount" AS sa
SET "zernioConnectionId" = zc."id"
FROM "ZernioConnection" AS zc
WHERE sa."provider" = 'ZERNIO'
  AND sa."workspaceId" = zc."workspaceId";
CREATE INDEX "SocialAccount_zernioConnectionId_idx" ON "SocialAccount"("zernioConnectionId");
ALTER TABLE "SocialAccount"
  ADD CONSTRAINT "SocialAccount_zernioConnectionId_fkey"
  FOREIGN KEY ("zernioConnectionId") REFERENCES "ZernioConnection"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
