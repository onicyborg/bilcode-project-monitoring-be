CREATE TABLE "BidAttempt" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "httpStatus" INTEGER,
  "postHttpStatus" INTEGER,
  "code" TEXT,
  "message" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "response" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BidAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BidAttempt_applicationId_createdAt_idx" ON "BidAttempt"("applicationId", "createdAt");
ALTER TABLE "BidAttempt" ADD CONSTRAINT "BidAttempt_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "BidApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
