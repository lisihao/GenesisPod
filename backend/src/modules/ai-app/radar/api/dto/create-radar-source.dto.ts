import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

/**
 * 读侧 enum（list / query / 旧数据兼容）— 含 X 是因为存量数据 + admin
 * 历史手动加的 X source 仍要能渲染 / 暂停 / 删除。
 */
export enum RadarSourceTypeDto {
  X = "X",
  YOUTUBE = "YOUTUBE",
  GITHUB = "GITHUB",
  HUGGING_FACE = "HUGGING_FACE",
  RSS = "RSS",
  CUSTOM = "CUSTOM",
}

/**
 * 写侧 enum（POST /sources, POST /sources/recommend/accept）— **禁 X**。
 *
 * 2026-05-17 业务策略：Nitter 全死 + 业界（Feedly/Inoreader）已淡化 X
 * 集成，AI 推荐 + admin 手动新加都禁 X，避免新增 dead source 噪音。
 * 旧 X 源仍可读 / 暂停 / 删除，但任何创建路径都拦在 DTO 校验层。
 */
export enum CreatableRadarSourceTypeDto {
  YOUTUBE = "YOUTUBE",
  GITHUB = "GITHUB",
  HUGGING_FACE = "HUGGING_FACE",
  RSS = "RSS",
  CUSTOM = "CUSTOM",
}

/**
 * 数据源 config（类型特定，自由 JSON，service 内做类型分发校验）：
 *
 * - YOUTUBE : `{ fetchTranscript?: boolean, region?: string }`
 * - GITHUB  : `{ language?: string, minStars?: number, sort?: "stars" | "updated" }`
 * - HUGGING_FACE: identifier `models[:query]` or `papers[:query]`
 * - RSS     : 无额外配置（identifier 即 URL）
 * - CUSTOM  : `{ listSelector: string, titleSelector?: string, linkSelector?: string, dateSelector?: string }`
 */
export class CreateRadarSourceDto {
  @IsEnum(CreatableRadarSourceTypeDto)
  type!: CreatableRadarSourceTypeDto;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  identifier!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /**
   * 信源权威性 1-5 星，参与 Stage A 打分（`scoring.ts` 的 authority 分量）。
   * 省略时走 DB `@default(3)`。
   *
   * 2026-07-29：此前 DB 有字段、scoring 会读，但两个写侧 DTO 都没暴露，
   * 导致所有源恒为 3 —— authority 分量对每个 item 贡献同一常数，零区分度。
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  authorityWeight?: number;
}

/**
 * 手工批量导入 body（POST /topics/:topicId/sources/bulk）。
 *
 * item 直接复用 CreateRadarSourceDto（字段完全一致，另起 item class 只是平行复制）。
 * 上限 20：CollectorRouter.fanOut 是无闸 Promise.all，批量条数 == 并发出网请求数，
 * 20 是 /recommend/accept 已在生产验证过的并发水位，要放大必须先给 fanOut 加并发闸。
 */
export class BulkCreateRadarSourcesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CreateRadarSourceDto)
  sources!: CreateRadarSourceDto[];
}
