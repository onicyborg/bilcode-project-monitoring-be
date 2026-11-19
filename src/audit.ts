import { Injectable } from "@nestjs/common";
import { Database } from "./database";

@Injectable()
export class Audit {
  constructor(private readonly db: Database) {}
  record(
    action: string,
    message: string,
    level = "INFO",
    category = "ACTIVITY",
    durationMs?: number,
  ) {
    return this.db.eventLog.create({
      data: { action, message, level, category, durationMs },
    });
  }
}
