-- Invalidate legacy panel sessions; monitoring configuration and data are preserved.
DROP TABLE "AdminSession";
CREATE TABLE "AdminRefreshSession" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminRefreshSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminRefreshSession_tokenHash_key" ON "AdminRefreshSession"("tokenHash");
CREATE INDEX "AdminRefreshSession_expiresAt_idx" ON "AdminRefreshSession"("expiresAt");
