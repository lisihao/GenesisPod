/**
 * S2 — collect stage adapter (multi-source fan-out)
 *
 * Stage primitive 是 "research" + mode "multi-source-fanout"。本 stage hook
 * 内部并发调既有 4 个 collector helper（RssCollector / YoutubeCollector /
 * XCollector / CustomCollector）—— 它们仅作为 stage 的实现细节存在，不是绕过
 * 框架的"独立编排"。
 *
 * 失败处理：
 *   - 单 source 失败 → 标记 SourceHealthService（指数 cooldown），不阻断其他 source
 *   - 全部 source 失败 → stage 仍返回（rawItems 为空），下游 S3-S7 自然短路
 *   - SourceHealthService 状态变化通过 EventBus emit radar.source.health-changed
 */
import { Injectable, Logger } from "@nestjs/common";
import type { RadarSource } from "@prisma/client";
import {
  RADAR_EVENTS,
  RADAR_FIRST_COLLECTION_LOOKBACK_MS,
  RADAR_PIPELINE_DEFAULTS,
} from "../../../runtime/radar.constants";
import { CollectorRouter } from "../../services/collectors/collector-router.service";
import { SourceHealthService } from "../../services/source/source-health.service";
import type {
  RadarMissionContext,
  RadarRawItem,
  RadarStageHookArgs,
  RadarStageRunner,
} from "./radar-stage-types";

/**
 * 逐源决定采集起点：从未成功抓取过的源（lastFetchAt 为空）用 90 天回捞窗口，
 * 其余沿用 S1 算出的 topic 级 since。
 *
 * 取两者中**更早**的那个，而不是无条件覆盖：手动「重新精选」的 topic 窗口是
 * 30 天，若某天把首采窗口调到比它更短，这里不能反而把范围缩小。
 */
export function resolveSourceSince(
  source: Pick<RadarSource, "lastFetchAt">,
  topicSince: Date,
  now: Date,
): Date {
  if (source.lastFetchAt) return topicSince;
  const firstCollectionSince = new Date(
    now.getTime() - RADAR_FIRST_COLLECTION_LOOKBACK_MS,
  );
  return firstCollectionSince < topicSince ? firstCollectionSince : topicSince;
}

@Injectable()
export class RadarS2CollectStage implements RadarStageRunner {
  private readonly log = new Logger(RadarS2CollectStage.name);

  constructor(
    private readonly router: CollectorRouter,
    private readonly health: SourceHealthService,
  ) {}

  async run(
    _args: RadarStageHookArgs,
    ctx: RadarMissionContext,
  ): Promise<void> {
    const sources = ctx.state.sources;
    const since = ctx.state.since;
    if (!sources || !since) {
      throw new Error("S2 collect: missing ctx.state.sources/since (S1 缺失?)");
    }
    if (sources.length === 0) {
      ctx.state.rawItems = [];
      ctx.state.metrics.sourcesAttempted = 0;
      return;
    }

    // sourceId → 人类可读标签（同 S8：label 优先，回退 identifier）
    const sourceLabels = new Map(
      sources.map((s) => [s.id, s.label?.trim() || s.identifier]),
    );

    // 新源首采回捞：sourceId → 该源本次实际使用的 since
    const now = new Date();
    const sinceBySourceId = new Map(
      sources.map((s) => [s.id, resolveSourceSince(s, since, now)]),
    );
    const backfilled = sources.filter((s) => !s.lastFetchAt);
    if (backfilled.length > 0) {
      this.log.log(
        `[${ctx.missionId}] S2 首采回捞 ${backfilled.length} 个新源（窗口 ${
          RADAR_FIRST_COLLECTION_LOOKBACK_MS / 86_400_000
        } 天）: ${backfilled.map((s) => s.label?.trim() || s.identifier).join(", ")}`,
      );
    }

    const results = await this.router.fanOut(
      sources,
      {
        since,
        perSourceLimit: RADAR_PIPELINE_DEFAULTS.perSourceItemLimit,
        userId: ctx.userId,
      },
      // 每个源一完成就 emit 实时进度（对齐 playground 细粒度事件流）
      (r) => {
        ctx.emit?.(RADAR_EVENTS.RUN_SOURCE_PROGRESS, {
          runId: ctx.missionId,
          topicId: ctx.input.topicId,
          sourceId: r.sourceId,
          sourceLabel: sourceLabels.get(r.sourceId) ?? r.sourceId,
          sourceType: r.type,
          items: r.items.length,
          durationMs: r.durationMs,
          error: r.error,
          // 抓到的条目样本（top 10），让 Drawer 显示"具体采集了什么文章"
          sample: r.items.slice(0, 10).map((it) => ({
            title: it.title,
            url: it.url,
          })),
        });
      },
      sinceBySourceId,
    );

    const rawItems: RadarRawItem[] = [];
    const sourceErrors: Array<{ sourceId: string; error: string }> = [];
    let sourcesFailed = 0;
    let sourcesThrottled = 0;
    const emptySources: Array<{
      sourceId: string;
      label: string;
      type: string;
    }> = [];

    for (const r of results) {
      if (ctx.signal.aborted) {
        this.log.warn(`[${ctx.missionId}] S2 abort signal received, halting`);
        throw new Error("aborted_during_collect");
      }
      if (r.error) {
        sourceErrors.push({ sourceId: r.sourceId, error: r.error });
        if (r.throttled) {
          // 上游限流不是源故障：既不 markFailure（否则指数 cooldown 累积到
          // FAILING + 24h），也不 markSuccess（这次确实没拿到数据）。错误仍然
          // 进 sourceErrors + 单独计数，UI 照常看得见，只是不烧健康度。
          sourcesThrottled++;
          this.log.warn(
            `[${ctx.missionId}] S2 source ${r.sourceId} 被上游限流，跳过健康度标记: ${r.error}`,
          );
          continue;
        }
        sourcesFailed++;
        await this.health.markFailure(r.sourceId, r.error);
        continue;
      }
      await this.health.markSuccess(r.sourceId);
      if (r.items.length === 0) {
        // 调通了但零产出：health 是绿的、没有 error，UI 上和「正常但本期无更新」
        // 长得一模一样。单次为 0 不判罪（低频源本来就可能没更新），但必须留痕，
        // 否则像 HF 榜单被窗口筛空那样，能静默空转到没人发现。
        emptySources.push({
          sourceId: r.sourceId,
          label: sourceLabels.get(r.sourceId) ?? r.sourceId,
          type: r.type,
        });
      }
      for (const item of r.items) {
        rawItems.push({
          ...item,
          sourceId: r.sourceId,
        });
      }
    }

    ctx.state.rawItems = rawItems;
    ctx.state.metrics.sourcesAttempted = sources.length;
    ctx.state.metrics.sourcesFailed = sourcesFailed;
    ctx.state.metrics.sourcesThrottled = sourcesThrottled;
    ctx.state.metrics.emptySources = emptySources;
    ctx.state.metrics.itemsFetched = rawItems.length;
    ctx.state.metrics.sourceErrors = sourceErrors;

    if (emptySources.length > 0) {
      this.log.warn(
        `[${ctx.missionId}] S2 ${emptySources.length} 个源调通但零产出: ${emptySources
          .map((s) => `${s.type}:${s.label}`)
          .join(", ")}`,
      );
    }

    this.log.log(
      `[${ctx.missionId}] S2 collect: sources=${sources.length} failed=${sourcesFailed} throttled=${sourcesThrottled} empty=${emptySources.length} items=${rawItems.length}`,
    );
  }
}
