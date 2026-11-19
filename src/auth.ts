import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { Database } from "./database";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

@Injectable()
export class AdminAuth {
  private readonly salt = randomBytes(16);
  private readonly passwordHash: Buffer;
  constructor(private readonly db: Database) {
    if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
      throw new Error("ADMIN_PASSWORD must contain at least 12 characters");
    }
    this.passwordHash = scryptSync(process.env.ADMIN_PASSWORD, this.salt, 64);
  }
  async login(username: string, password: string) {
    const matches = timingSafeEqual(
      scryptSync(password, this.salt, 64),
      this.passwordHash,
    );
    if (!matches || username !== (process.env.ADMIN_USERNAME || "geats")) {
      throw new UnauthorizedException("Username atau password tidak sesuai.");
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await this.db.adminSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    await this.db.adminSession.create({
      data: { tokenHash: hash(token), expiresAt },
    });
    return { token, expiresAt };
  }
  async authenticated(token?: string) {
    if (!token || token.length > 128) return false;
    const session = await this.db.adminSession.findUnique({
      where: { tokenHash: hash(token) },
    });
    return Boolean(session && session.expiresAt > new Date());
  }
  async logout(token?: string) {
    if (token)
      await this.db.adminSession.deleteMany({
        where: { tokenHash: hash(token) },
      });
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AdminAuth) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    if (!(await this.auth.authenticated(request.cookies?.monitor_session))) {
      throw new UnauthorizedException("Silakan masuk ke panel monitoring.");
    }
    return true;
  }
}

@Injectable()
export class OriginGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
    const allowed = (process.env.APP_ORIGIN || "http://localhost:3100").split(
      ",",
    );
    if (!request.headers.origin || !allowed.includes(request.headers.origin)) {
      throw new ForbiddenException("Origin request tidak diizinkan.");
    }
    return true;
  }
}
