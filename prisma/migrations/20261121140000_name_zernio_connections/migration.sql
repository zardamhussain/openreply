-- Name a Zernio connection, so several keys in one workspace can be told
-- apart. The label is the user's own name for the connection; the profile
-- name is used when there is none.
ALTER TABLE "ZernioConnection" ADD COLUMN "label" TEXT;
