import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Request } from "express";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { Database } from "./database";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const issuer = "bilcode-project-monitoring";
const accessSeconds = 15 * 60;
const refreshSeconds = 30 * 24 * 60 * 60;
type Claims = { sub: string; sid: string; purpose: "access" | "refresh" };
export const refreshCookieOptions = () => ({
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/api/auth",
});

@Injectable()
export class AdminAuth {
  private readonly salt = randomBytes(16);
  private readonly passwordHash: Buffer;
  private readonly jwt = new JwtService();
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly username = process.env.ADMIN_USERNAME || "geats";
  constructor(private readonly db: Database) {
    if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12)
      throw new Error("ADMIN_PASSWORD must contain at least 12 characters");
    this.accessSecret = process.env.JWT_ACCESS_SECRET || "";
    this.refreshSecret = process.env.JWT_REFRESH_SECRET || "";
    if (
      ![this.accessSecret, this.refreshSecret].every((value) =>
        /^[a-f0-9]{64}$/i.test(value),
      ) ||
      this.accessSecret === this.refreshSecret
    )
      throw new Error("Configure distinct 64-character hex JWT secrets");
    this.passwordHash = scryptSync(process.env.ADMIN_PASSWORD, this.salt, 64);
  }
  private async verify(token: string | undefined, purpose: Claims["purpose"]) {
    if (!token || token.length > 4096) return null;
    try {
      const claims = await this.jwt.verifyAsync<Claims>(token, {
        secret: purpose === "access" ? this.accessSecret : this.refreshSecret,
        algorithms: ["HS256"],
        issuer,
        audience: `monitor-${purpose}`,
      });
      if (
        claims.purpose !== purpose ||
        claims.sub !== this.username ||
        typeof claims.sid !== "string"
      )
        return null;
      return claims;
    } catch {
      return null;
    }
  }
  private async tokens(sid: string, expiresAt: Date) {
    const [access_token, refreshToken] = await Promise.all([
      this.jwt.signAsync(
        { sid, purpose: "access" },
        {
          secret: this.accessSecret,
          algorithm: "HS256",
          issuer,
          audience: "monitor-access",
          subject: this.username,
          jwtid: randomUUID(),
          expiresIn: accessSeconds,
        },
      ),
      this.jwt.signAsync(
        { sid, purpose: "refresh" },
        {
          secret: this.refreshSecret,
          algorithm: "HS256",
          issuer,
          audience: "monitor-refresh",
          subject: this.username,
          jwtid: randomUUID(),
          expiresIn: Math.max(
            1,
            Math.floor((expiresAt.getTime() - Date.now()) / 1000),
          ),
        },
      ),
    ]);
    return {
      access_token,
      token_type: "Bearer",
      expires_in: accessSeconds,
      username: this.username,
      refreshToken,
      expiresAt,
    };
  }
  async login(username: string, password: string) {
    const matches = timingSafeEqual(
      scryptSync(password, this.salt, 64),
      this.passwordHash,
    );
    if (!matches || username !== this.username)
      throw new UnauthorizedException("Username atau password tidak sesuai.");
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + refreshSeconds * 1000);
    const tokens = await this.tokens(id, expiresAt);
    await this.db.adminRefreshSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    await this.db.adminRefreshSession.create({
      data: { id, tokenHash: hash(tokens.refreshToken), expiresAt },
    });
    return tokens;
  }
  async refresh(token?: string) {
    const claims = await this.verify(token, "refresh");
    if (!claims || !token)
      throw new UnauthorizedException(
        "Sesi panel berakhir. Silakan masuk kembali.",
      );
    const session = await this.db.adminRefreshSession.findUnique({
      where: { id: claims.sid },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.tokenHash !== hash(token)
    )
      throw new UnauthorizedException("Refresh token tidak berlaku.");
    const tokens = await this.tokens(session.id, session.expiresAt);
    const rotated = await this.db.adminRefreshSession.updateMany({
      where: {
        id: session.id,
        tokenHash: hash(token),
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { tokenHash: hash(tokens.refreshToken) },
    });
    if (rotated.count !== 1)
      throw new UnauthorizedException("Refresh token sudah digunakan.");
    return tokens;
  }
  async authenticated(token?: string) {
    const claims = await this.verify(token, "access");
    if (!claims) return false;
    const session = await this.db.adminRefreshSession.findUnique({
      where: { id: claims.sid },
    });
    return Boolean(
      session && !session.revokedAt && session.expiresAt > new Date(),
    );
  }
  async logout(refreshToken?: string, accessToken?: string) {
    const claims = await this.verify(refreshToken, "refresh");
    if (claims && refreshToken)
      await this.db.adminRefreshSession.updateMany({
        where: {
          id: claims.sid,
          tokenHash: hash(refreshToken),
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    const access = await this.verify(accessToken, "access");
    if (access)
      await this.db.adminRefreshSession.updateMany({
        where: { id: access.sid, revokedAt: null },
        data: { revokedAt: new Date() },
      });
  }
}
export const bearerToken = (request: Request) =>
  /^Bearer (\S+)$/i.exec(request.headers.authorization || "")?.[1];
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AdminAuth) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    if (!(await this.auth.authenticated(bearerToken(request))))
      throw new UnauthorizedException("Silakan masuk ke panel monitoring.");
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
    if (!request.headers.origin || !allowed.includes(request.headers.origin))
      throw new ForbiddenException("Origin request tidak diizinkan.");
    return true;
  }
}
