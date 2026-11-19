-- CreateTable
CREATE TABLE "AdminSession" (
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "Configuration" (
    "id" TEXT NOT NULL DEFAULT 'main',
    "intervalSeconds" INTEGER NOT NULL DEFAULT 300,
    "phone" TEXT NOT NULL DEFAULT '6281347890520',
    "gowaUrl" TEXT NOT NULL DEFAULT 'https://wa.geats.web.id',
    "gowaUsername" TEXT NOT NULL DEFAULT 'geats',
    "gowaPasswordEncrypted" TEXT,
    "deviceId" TEXT NOT NULL DEFAULT 'personal',
    "authAlerts" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Configuration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BilcodeSession" (
    "id" TEXT NOT NULL DEFAULT 'main',
    "refreshTokenEncrypted" TEXT,
    "authStatus" TEXT NOT NULL DEFAULT 'MISSING',
    "importedAt" TIMESTAMP(3),
    "validatedAt" TIMESTAMP(3),
    "refreshedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "BilcodeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorState" (
    "id" TEXT NOT NULL DEFAULT 'main',
    "desiredRunning" BOOLEAN NOT NULL DEFAULT false,
    "lastCheckAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "authAlerted" BOOLEAN NOT NULL DEFAULT false,
    "gowaConnected" BOOLEAN,
    "gowaCheckedAt" TIMESTAMP(3),

    CONSTRAINT "MonitorState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "durationMs" INTEGER,
    "available" INTEGER NOT NULL DEFAULT 0,
    "newProjects" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "CheckRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "parts" JSONB NOT NULL,
    "nextPart" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLog" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'INFO',
    "action" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

-- CreateIndex
CREATE INDEX "CheckRun_startedAt_idx" ON "CheckRun"("startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_projectKey_key" ON "Notification"("projectKey");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "EventLog_category_createdAt_idx" ON "EventLog"("category", "createdAt" DESC);
