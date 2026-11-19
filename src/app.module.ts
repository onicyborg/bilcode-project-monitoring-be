import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AdminAuth, AdminGuard, OriginGuard } from "./auth";
import { Database } from "./database";
import { Secrets } from "./secrets";
import { Audit } from "./audit";
import { Upstream } from "./upstream";
import { Monitor } from "./monitor";
import {
  AuthController,
  HealthController,
  LogsController,
  MonitorController,
  SessionController,
  SettingsController,
} from "./controllers";

@Module({
  imports: [
    ThrottlerModule.forRoot([
      { ttl: 60000, limit: process.env.NODE_ENV === "test" ? 2000 : 180 },
    ]),
  ],
  controllers: [
    AuthController,
    HealthController,
    LogsController,
    MonitorController,
    SessionController,
    SettingsController,
  ],
  providers: [
    Database,
    Secrets,
    Audit,
    Upstream,
    Monitor,
    AdminAuth,
    AdminGuard,
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
