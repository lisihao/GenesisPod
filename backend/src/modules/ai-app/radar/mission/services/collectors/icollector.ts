import { RadarSource } from "@prisma/client";

/**
 * 从外部源采集到的原始数据项（写入 RadarItem 前的中间形态）。
 */
export interface RawCollectedItem {
  /** 原始 ID（X tweet id / YT video id / RSS guid / custom URL） */
  externalId: string;
  /** 内容指纹（dedup 用，sha256(title + content[:1000])） */
  contentHash: string;
  /** 标题（>= title-only 时必填） */
  title: string | null;
  /** 长正文（可能为 null，比如 X 短文已经在 title 里） */
  content: string | null;
  author: string | null;
  authorAvatar: string | null;
  url: string | null;
  publishedAt: Date;
  /** 平台指标 {likes,views,shares,...} */
  metrics: Record<string, number | string> | null;
  /** 原始 payload（写入 RadarItem.raw 字段，方便 reprocess） */
  raw: Record<string, unknown>;
}

export interface CollectContext {
  /** 仅返回 publishedAt > since 的项 */
  since: Date;
  /** 本次单 source 最多返回 N 条（防 quota 爆 + LLM 暴账） */
  perSourceLimit: number;
  /** 调用上下文 user id（用于走 BYOK secret） */
  userId: string;
}

/**
 * 上游限流（HTTP 429 / GitHub 403 + `x-ratelimit-remaining: 0`）。
 *
 * 必须与「源坏了」区分开：SourceHealthService.markFailure 是指数 cooldown，
 * 连续 5 次就把源打成 FAILING + 24h 冷却。GitHub 匿名 Search 配额只有 10 次/分钟，
 * 同一个 cron tick 上几个源并发就能撞上——把瞬时限流记成源故障，会让一次配额抖动
 * 停掉这个源一整天。S2 见到 throttled 只记录、不计健康度，等下个 tick 自然重试。
 */
export class CollectorThrottleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectorThrottleError";
  }
}

/**
 * Collector 接口 —— 每种 RadarSourceType 一个实现。
 *
 * 契约：
 * 1. 单 source 失败 throw → CollectorRouter 捕获并标记 source health
 *    （上游限流请 throw CollectorThrottleError，见上）
 * 2. 不直接写 DB，只返回 RawCollectedItem[]
 * 3. 返回为空数组合法（表示无新数据）
 * 4. 必须按 ctx.perSourceLimit 截断
 */
export interface ICollector {
  /**
   * 支持的 source type（一对一）。
   */
  readonly type: string;

  /**
   * 拉取数据。失败 throw（带可读 message）。
   */
  fetch(source: RadarSource, ctx: CollectContext): Promise<RawCollectedItem[]>;
}
