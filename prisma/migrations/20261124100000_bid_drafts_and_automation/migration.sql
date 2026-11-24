ALTER TABLE "Configuration" ADD COLUMN "autoBid" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "BidApplication" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL';
CREATE TABLE "BidDraft" (
  "projectId" INTEGER NOT NULL,
  "version" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "isDevelopment" BOOLEAN NOT NULL DEFAULT false,
  "reason" TEXT,
  "proposalPayload" JSONB,
  "lastError" TEXT,
  "autoAttempted" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BidDraft_pkey" PRIMARY KEY ("projectId")
);
