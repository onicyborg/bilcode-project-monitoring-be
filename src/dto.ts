import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { Type } from "class-transformer";

export class LoginDto {
  @ApiProperty() @IsString() @MaxLength(80) username!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(256) password!: string;
}
export class CookieDto {
  @ApiProperty({ description: "JSON export cookie, tidak dicatat pada log." })
  @IsString()
  @MinLength(2)
  @MaxLength(100000)
  cookieJson!: string;
}
export class RequestOtpDto {
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
}
export class VerifyOtpDto extends RequestOtpDto {
  @ApiProperty() @Matches(/^\d{6}$/) code!: string;
}
export class SettingsDto {
  @ApiProperty() @IsInt() @Min(60) @Max(3600) intervalSeconds!: number;
  @ApiProperty() @Matches(/^[1-9]\d{7,14}$/) phone!: string;
  @ApiProperty()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ["https", "http"],
  })
  gowaUrl!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) gowaUsername!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(256)
  gowaPassword?: string;
  @ApiProperty() @Matches(/^[a-zA-Z0-9._-]{1,80}$/) deviceId!: string;
  @ApiProperty() @IsBoolean() authAlerts!: boolean;
}
export class PageDto {
  @ApiPropertyOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @ApiPropertyOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit =
    15;
}
export class LogQueryDto extends PageDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(["ACTIVITY", "REQUEST", "NOTIFICATION"])
  category?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(["INFO", "SUCCESS", "WARNING", "ERROR"])
  level?: string;
}
