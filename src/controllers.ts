import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  ParseIntPipe,
  ServiceUnavailableException,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import {
  AdminAuth,
  AdminGuard,
  bearerToken,
  refreshCookieOptions,
} from "./auth";
import { Audit } from "./audit";
import { Database } from "./database";
import {
  CookieDto,
  LoginDto,
  LogQueryDto,
  PageDto,
  SettingsDto,
  RequestOtpDto,
  VerifyOtpDto,
} from "./dto";
import { Monitor } from "./monitor";
import { Bids } from "./bids";
import { SubmitBidDto, BidsQueryDto } from "./dto";

@ApiTags("Bids")
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller("bids")
export class BidsController {
  constructor(
    private readonly bids: Bids,
    private readonly monitor: Monitor,
  ) {}
  @Get() dashboard(@Query() query: BidsQueryDto) {
    return this.bids.dashboard(query.page, query.limit, query);
  }
  @Post("refresh") refresh() {
    return this.monitor.refreshBidDashboard();
  }
  @Get("projects/:id/attempts") attempts(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: PageDto,
  ) {
    return this.bids.attempts(id, query.page, query.limit);
  }
  @Post("projects/:id/submit")
  @Throttle({
    default: { limit: process.env.NODE_ENV === "test" ? 2000 : 5, ttl: 60000 },
  })
  submit(@Param("id", ParseIntPipe) id: number, @Body() body: SubmitBidDto) {
    return this.monitor.submitBid(id, body.version);
  }
}

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
    const { refreshToken, expiresAt, ...result } = await this.auth.login(
      body.username,
      body.password,
    );
    response.cookie("monitor_refresh", refreshToken, {
      ...refreshCookieOptions(),
      expires: expiresAt,
    });
    response.clearCookie("monitor_session", { path: "/" });
    response.setHeader("Cache-Control", "no-store");
    await this.audit.record(
      "ADMIN_LOGIN",
      "Operator masuk ke panel monitoring.",
    );
    return result;
  }
  @Post("refresh")
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "no-store");
    const { refreshToken, expiresAt, ...result } = await this.auth.refresh(
      request.cookies?.monitor_refresh,
    );
    response.cookie("monitor_refresh", refreshToken, {
      ...refreshCookieOptions(),
      expires: expiresAt,
    });
    return result;
  }
  @Get("me")
  @UseGuards(AdminGuard)
  @ApiBearerAuth()
  me() {
    return { username: process.env.ADMIN_USERNAME || "geats" };
  }
  @Post("logout")
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.logout(
      request.cookies?.monitor_refresh,
      bearerToken(request),
    );
    response.clearCookie("monitor_refresh", refreshCookieOptions());
    response.setHeader("Cache-Control", "no-store");
    await this.audit.record(
      "ADMIN_LOGOUT",
      "Operator keluar dari panel. Status monitoring tidak diubah.",
    );
    return { message: "Kamu sudah keluar dari panel." };
  }
}

@ApiTags("Monitor")
@ApiBearerAuth()
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
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller("session")
export class SessionController {
  constructor(private readonly monitor: Monitor) {}
  @Post("otp/request")
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  requestOtp(@Body() body: RequestOtpDto) {
    return this.monitor.requestOtp(body.email);
  }
  @Post("otp/verify")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  verifyOtp(@Body() body: VerifyOtpDto) {
    return this.monitor.verifyOtp(body.email, body.code);
  }
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
@ApiBearerAuth()
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
@ApiBearerAuth()
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
  constructor(
    private readonly db: Database,
    private readonly monitor: Monitor,
  ) {}
  @Get() async health() {
    if (!this.monitor.isLeaseHealthy())
      throw new ServiceUnavailableException(
        "Koneksi pengendali monitoring terputus.",
      );
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.db.$queryRaw`SELECT 1`,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Health timeout")), 3000);
        }),
      ]);
      return { status: "ok", database: "connected" };
    } catch {
      throw new ServiceUnavailableException("Koneksi database belum tersedia.");
    } finally {
      clearTimeout(timer);
    }
  }
}
