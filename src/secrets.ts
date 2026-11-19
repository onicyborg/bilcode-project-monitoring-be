import { Injectable } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

@Injectable()
export class Secrets {
  private readonly key: Buffer;
  constructor() {
    const value = process.env.ENCRYPTION_KEY || "";
    if (!/^[a-f0-9]{64}$/i.test(value))
      throw new Error("ENCRYPTION_KEY must contain 64 hexadecimal characters");
    this.key = Buffer.from(value, "hex");
  }
  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), encrypted]
      .map((item) => item.toString("base64"))
      .join(".");
  }
  decrypt(value: string) {
    const [iv, tag, data] = value
      .split(".")
      .map((item) => Buffer.from(item, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  }
}
