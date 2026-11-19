import "reflect-metadata";
import "dotenv/config";
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  ValidationPipe,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { json } from "express";
import type { Request, Response } from "express";
import { AppModule } from "./app.module";
import { Audit } from "./audit";

@Catch()
class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const payload = error.getResponse();
      response
        .status(error.getStatus())
        .json(typeof payload === "string" ? { message: payload } : payload);
    } else if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      (error.status === 400 || error.status === 413)
    ) {
      response.status(error.status).json({
        message:
          error.status === 413
            ? "Body request terlalu besar."
            : "Body JSON tidak valid.",
      });
    } else {
      console.error("Unhandled backend error; request failed.");
      response.status(500).json({
        message:
          "Terjadi kesalahan internal. Coba kembali dan periksa koneksi database.",
      });
    }
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use((_request: Request, response: Response, next: () => void) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(helmet({ contentSecurityPolicy: false }));
  const audit = app.get(Audit);
  app.use((request: Request, response: Response, next: () => void) => {
    const started = Date.now();
    response.on("finish", () => {
      const path = request.path;
      if (
        path.startsWith("/api/") &&
        !path.startsWith("/api/health") &&
        !path.startsWith("/api/docs")
      ) {
        void audit
          .record(
            "HTTP_REQUEST",
            `${request.method} ${path} · ${response.statusCode}`,
            response.statusCode >= 400 ? "WARNING" : "INFO",
            "REQUEST",
            Date.now() - started,
          )
          .catch(() => undefined);
      }
    });
    next();
  });
  app.use(json({ limit: "256kb" }));
  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: (error?: unknown) => void,
    ) => {
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        (error.status === 400 || error.status === 413)
      ) {
        response.status(error.status).json({
          message:
            error.status === 413
              ? "Body request terlalu besar."
              : "Body JSON tidak valid.",
        });
        return;
      }
      next(error);
    },
  );
  app.use(cookieParser());
  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new SafeErrors());
  if (process.env.NODE_ENV !== "production") {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("Bilcode Monitoring API")
        .setVersion("1.0")
        .addBearerAuth()
        .addCookieAuth("monitor_refresh")
        .build(),
    );
    SwaggerModule.setup("api/docs", app, document);
  }
  app.enableShutdownHooks();
  await app.listen(
    Number(process.env.API_PORT || 4100),
    process.env.API_HOST || "127.0.0.1",
  );
}
void bootstrap().catch(() => {
  console.error(
    "Backend startup failed. Check database, encryption key, and admin configuration.",
  );
  process.exit(1);
});
