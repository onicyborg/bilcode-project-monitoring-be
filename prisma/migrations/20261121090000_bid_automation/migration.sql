CREATE TABLE "BidProject" (
 "projectId" INTEGER NOT NULL, "title" TEXT NOT NULL, "payload" JSONB NOT NULL,
 "available" BOOLEAN NOT NULL DEFAULT true, "hasApplied" BOOLEAN NOT NULL DEFAULT false,
 "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "BidProject_pkey" PRIMARY KEY ("projectId")
);
CREATE TABLE "BidApplication" (
 "id" TEXT NOT NULL, "projectId" INTEGER NOT NULL, "title" TEXT NOT NULL,
 "upstreamId" INTEGER, "state" TEXT NOT NULL, "status" TEXT, "proposalPayload" JSONB,
 "lastError" TEXT, "confirmedAt" TIMESTAMP(3), "lastSyncedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "BidApplication_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BidApplication_projectId_key" ON "BidApplication"("projectId");
CREATE UNIQUE INDEX "BidApplication_upstreamId_key" ON "BidApplication"("upstreamId");
CREATE TABLE "BidStatusEvent" (
 "id" TEXT NOT NULL, "applicationId" TEXT NOT NULL, "previousStatus" TEXT, "nextStatus" TEXT NOT NULL,
 "parts" JSONB NOT NULL, "nextPart" INTEGER NOT NULL DEFAULT 0, "sentAt" TIMESTAMP(3), "lastError" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "BidStatusEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BidStatusEvent_sentAt_createdAt_idx" ON "BidStatusEvent"("sentAt", "createdAt");
ALTER TABLE "BidStatusEvent" ADD CONSTRAINT "BidStatusEvent_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "BidApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "BidSyncState" (
 "id" TEXT NOT NULL DEFAULT 'main', "lastSyncedAt" TIMESTAMP(3), "lastError" TEXT,
 CONSTRAINT "BidSyncState_pkey" PRIMARY KEY ("id")
);
