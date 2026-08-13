import { Injectable, Logger } from "@nestjs/common";
import { RadarSource, RadarSourceType } from "@prisma/client";
import {
  CollectContext,
  CollectorThrottleError,
  ICollector,
  RawCollectedItem,
} from "./icollector";
import { RssCollector } from "./rss-collector.service";
import { YoutubeCollector } from "./youtube-collector.service";
import { XCollector } from "./x-collector.service";
import { CustomCollector } from "./custom-collector.service";
import { GithubCollector } from "./github-collector.service";
import { HuggingFaceCollector } from "./hugging-face-collector.service";

export interface CollectResult {
  sourceId: string;
  type: RadarSourceType;
  items: RawCollectedItem[];
  error: string | null;
  /**
   * true = 失败原因是上游限流（CollectorThrottleError），不是源本身坏了。
   * caller 据此跳过 source health 标记，避免瞬时配额抖动触发 24h 冷却。
   */
  throttled: boolean;
  /** 单 source 耗时 ms */
  durationMs: number;
}

/**
 * CollectorRouter —— 按 RadarSourceType 路由到具体 collector。
 *
 * fanOut: Promise.allSettled 并发，单 source 失败不阻塞其他。
 * 单 source 失败由 caller 标记 source health（SourceHealthService）。
 */
@Injectable()
export class CollectorRouter {
  private readonly log = new Logger(CollectorRouter.name);
  private readonly registry: Map<RadarSourceType, ICollector>;

  constructor(
    rss: RssCollector,
    yt: YoutubeCollector,
    x: XCollector,
    custom: CustomCollector,
    github: GithubCollector,
    huggingFace: HuggingFaceCollector,
  ) {
    this.registry = new Map<RadarSourceType, ICollector>([
      ["RSS", rss],
      ["YOUTUBE", yt],
      ["X", x],
      ["CUSTOM", custom],
      ["GITHUB", github],
      ["HUGGING_FACE", huggingFace],
    ]);
  }

  /**
   * @param perSourceSince 逐源覆盖采集起点（sourceId → since）。缺省或查不到时
   *   用 ctx.since。窗口该给谁由 caller（S2）决定，这里只查表，不含业务规则。
   */
  async fanOut(
    sources: RadarSource[],
    ctx: CollectContext,
    onResult?: (r: CollectResult) => void,
    perSourceSince?: ReadonlyMap<string, Date>,
  ): Promise<CollectResult[]> {
    if (sources.length === 0) return [];
    // 每个源一完成就回调（实时进度）——不等 Promise.all 全部 resolve，
    // 这样前端能在采集进行中逐源点亮，而非结束后一次性出现。
    const tasks = sources.map(async (s) => {
      const since = perSourceSince?.get(s.id);
      const r = await this.fetchOne(s, since ? { ...ctx, since } : ctx);
      onResult?.(r);
      return r;
    });
    return Promise.all(tasks);
  }

  private async fetchOne(
    source: RadarSource,
    ctx: CollectContext,
  ): Promise<CollectResult> {
    const collector = this.registry.get(source.type);
    if (!collector) {
      return {
        sourceId: source.id,
        type: source.type,
        items: [],
        error: `Unsupported source type: ${source.type}`,
        throttled: false,
        durationMs: 0,
      };
    }
    const start = Date.now();
    try {
      const items = await collector.fetch(source, ctx);
      return {
        sourceId: source.id,
        type: source.type,
        items,
        error: null,
        throttled: false,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const msg = (err as Error).message || String(err);
      const throttled = err instanceof CollectorThrottleError;
      this.log.warn(
        `Collector ${source.type}#${source.id} ${
          throttled ? "throttled" : "failed"
        }: ${msg}`,
      );
      return {
        sourceId: source.id,
        type: source.type,
        items: [],
        error: msg,
        throttled,
        durationMs: Date.now() - start,
      };
    }
  }
}
