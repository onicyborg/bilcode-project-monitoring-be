ALTER TABLE "BidApplication" ADD COLUMN "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "BidApplication" SET "submittedAt" = COALESCE("confirmedAt", "createdAt");
CREATE INDEX "BidApplication_submittedAt_id_idx" ON "BidApplication"("submittedAt", "id");
