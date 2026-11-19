import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { AdminAuth, AdminGuard } from "./auth";
import { Audit } from "./audit";
import { Database } from "./database";
import { CookieDto, LoginDto, LogQueryDto, PageDto, SettingsDto } from "./dto";
import { Monitor } from "./monitor";

@ApiTags("Authentication")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AdminAuth,
    private readonly audit: Audit,
  ) {}
  @Post("login")
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { token, expiresAt } = await this.auth.login(
      body.username,
      body.password,
    );
    response.cookie("monitor_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      expires: expiresAt,
      path: "/",
    });
    await this.audit.record(
      "ADMIN_LOGIN",
      "Operator masuk ke panel monitoring.",
    );
    return { username: process.env.ADMIN_USERNAME || "geats", expiresAt };
  }
  @Get("me")
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  me() {
    return { username: process.env.ADMIN_USERNAME || "geats" };
  }
  @Post("logout")
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.logout(request.cookies?.monitor_session);
    response.clearCookie("monitor_session", {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
    });
    await this.audit.record(
      "ADMIN_LOGOUT",
      "Operator keluar dari panel. Status monitoring tidak diubah.",
    );
    return { message: "Kamu sudah keluar dari panel." };
  }
}

@ApiTags("Monitor")
@ApiCookieAuth()
@UseGuards(AdminGuard)
@Controller("monitor")
export class MonitorController {
  constructor(private readonly monitor: Monitor) {}
  @Get("summary") summary() {
    return this.monitor.summary();
  }
  @Post("start") start() {
    return this.monitor.start();
  }
  @Post("stop") stop() {
    return this.monitor.stop();
  }
  @Post("check") check() {
    return this.monitor.checkOnce();
  }
}

@ApiTags("Bilcode session")
@ApiCookieAuth()
@UseGuards(AdminGuard)
@Controller("session")
export class SessionController {
  constructor(private readonly monitor: Monitor) {}
  @Put("cookie") import(@Body() body: CookieDto) {
    return this.monitor.importCookie(body.cookieJson);
  }
  @Delete("cookie") remove() {
    return this.monitor.removeCookie();
  }
  @Post("validate") validate() {
    return this.monitor.validateSession();
  }
}

@ApiTags("Configuration")
@ApiCookieAuth()
@UseGuards(AdminGuard)
@Controller("settings")
export class SettingsController {
  constructor(private readonly monitor: Monitor) {}
  @Put() save(@Body() body: SettingsDto) {
    return this.monitor.settings(body);
  }
  @Post("gowa/check") connection() {
    return this.monitor.testConnection();
  }
  @Post("gowa/test-message") message() {
    return this.monitor.testMessage();
  }
}

@ApiTags("Logs")
@ApiCookieAuth()
@UseGuards(AdminGuard)
@Controller("logs")
export class LogsController {
  constructor(private readonly db: Database) {}
  @Get("checks") async checks(@Query() query: PageDto) {
    const [items, total] = await Promise.all([
      this.db.checkRun.findMany({
        orderBy: { startedAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.db.checkRun.count(),
    ]);
    return {
      items,
      total,
      page: query.page,
      pages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }
  @Get("events") async events(@Query() query: LogQueryDto) {
    const where = {
      category: query.category || "ACTIVITY",
      ...(query.level ? { level: query.level } : {}),
    };
    const [items, total] = await Promise.all([
      this.db.eventLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.db.eventLog.count({ where }),
    ]);
    return {
      items,
      total,
      page: query.page,
      pages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }
  @Get("notifications") async notifications(@Query() query: PageDto) {
    const [items, total] = await Promise.all([
      this.db.notification.findMany({
        select: {
          id: true,
          projectKey: true,
          payload: true,
          status: true,
          attempts: true,
          createdAt: true,
          sentAt: true,
          lastError: true,
        },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.db.notification.count(),
    ]);
    return {
      items,
      total,
      page: query.page,
      pages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }
  @Get("notifications/:id") notification(
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.db.notification.findUniqueOrThrow({ where: { id } });
  }
}

@Controller("health")
export class HealthController {
  constructor(private readonly db: Database) {}
  @Get() async health() {
    await this.db.$queryRaw`SELECT 1`;
    return { status: "ok", database: "connected" };
  }
}
