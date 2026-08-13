/**
 * S7 — signal insight synthesis stage adapter
 *
 * primitive=synthesize, roleId=signal-analyst, stateful=true
 *
 * 输入：ctx.state（含 topic / uniqueItems / relevanceScores / qualityScores / entityMap）
 * + 上期 RadarInsight（按 topicId 查最近 1 条，用于对照分析）。
 *
 * 只用 accepted 条件（relevance>=60 && quality>=50）的 item 喂 LLM。
 * 结果写入 ctx.state.insightPayload（不写 DB，由 s8 写库）。
 *
 * 合成逻辑本体在 RadarInsightSynthesisService —— 与用户手动触发的 ad-hoc 分析
 * 共用同一套 prompt 和证据门禁，本 stage 只负责从 ctx.state 组装输入。
 *
 * topic.analysisMode='on-demand' 时整步跳过：这类主题的分析由用户在 feed 里
 * 勾选 item 触发，不自动跑。
 */
import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RADAR_PIPELINE_DEFAULTS } from "../../../runtime/radar.constants";
import { isOnDemandAnalysis } from "../../../runtime/analysis-mode";
import {
  buildEntityFreq,
  RadarInsightSynthesisService,
  type InsightSynthesisItem,
} from "../../services/insight/radar-insight-synthesis.service";
import { recordSkippedStage } from "./radar-stage-types";
import type {
  RadarMissionContext,
  RadarStageHookArgs,
  RadarStageRunner,
} from "./radar-stage-types";

@Injectable()
export class RadarS7InsightStage implements RadarStageRunner {
  private readonly log = new Logger(RadarS7InsightStage.name);

  constructor(
    private readonly synthesis: RadarInsightSynthesisService,
    private readonly prisma: PrismaService,
  ) {}

  async run(args: RadarStageHookArgs, ctx: RadarMissionContext): Promise<void> {
    if (ctx.signal.aborted) throw new Error("aborted_during_insight_synthesis");

    const topic = ctx.state.topic;
    if (!topic) throw new Error("S7 insight: ctx.state.topic 缺失");

    if (isOnDemandAnalysis(topic)) {
      recordSkippedStage(ctx, "s7-insight");
      this.log.log(
        `[${ctx.missionId}] S7 insight: topic analysisMode=on-demand，跳过自动洞察（改由用户勾选 item 触发 ad-hoc 分析）`,
      );
      return;
    }

    const newItemIds = ctx.state.newItemIds ?? [];
    const uniqueItems = ctx.state.uniqueItems ?? [];
    const relevanceScores = ctx.state.relevanceScores ?? new Map();
    const qualityScores = ctx.state.qualityScores ?? new Map();
    const entityMap = ctx.state.entityMap ?? new Map();
    const sourceMap = new Map(
      (ctx.state.sources ?? []).map((source) => [source.id, source]),
    );

    // 筛选 accepted 条目（relevance>=60 && quality>=50）
    const relMin = RADAR_PIPELINE_DEFAULTS.acceptedRelevanceMin;
    const qualMin = RADAR_PIPELINE_DEFAULTS.acceptedQualityMin;

    const acceptedItems: InsightSynthesisItem[] = uniqueItems
      .map((raw, idx) => ({
        id: newItemIds[idx],
        title: raw.title ?? "",
        // 有 aiSummary 用摘要省 token，没有就退回正文（由 service 统一截断）
        summary:
          qualityScores.get(newItemIds[idx])?.summary ?? raw.content ?? "",
        url: raw.url ?? "",
        publishedAt: raw.publishedAt,
        sourceId: raw.sourceId,
        sourceType: sourceMap.get(raw.sourceId)?.type ?? "UNKNOWN",
        sourceLabel:
          sourceMap.get(raw.sourceId)?.label ??
          sourceMap.get(raw.sourceId)?.identifier ??
          raw.sourceId,
        author: raw.author,
      }))
      .filter((item) => {
        const rel = relevanceScores.get(item.id);
        const qual = qualityScores.get(item.id);
        return (
          rel !== undefined &&
          rel.score >= relMin &&
          qual !== undefined &&
          qual.score >= qualMin
        );
      });

    if (acceptedItems.length === 0) {
      this.log.log(`[${ctx.missionId}] S7 insight: 无 accepted item，跳过`);
      return;
    }

    // 查上期 insight（对照分析用）—— 只对照周期洞察，不拿用户的 ad-hoc 分析当基线
    const prevInsight = await this.prisma.radarInsight.findFirst({
      where: { topicId: topic.id, kind: "scheduled" },
      orderBy: { periodTo: "desc" },
    });

    const systemPrompt =
      args.systemPrompt ||
      "你是 AI 雷达的信号分析师，结合本期新动态与历史基线，生成结构化洞察报告。";

    const entityFreq = buildEntityFreq(
      entityMap,
      acceptedItems.map((i) => i.id),
    );

    if (ctx.signal.aborted) throw new Error("aborted_during_insight_synthesis");

    const insightPayload = await this.synthesis.synthesize({
      systemPrompt,
      topic: {
        name: topic.name,
        description: topic.description,
        entityType: topic.entityType,
      },
      items: acceptedItems,
      entityFreq,
      prevInsight,
      userId: ctx.userId,
      operationName: "radar.s7-insight",
      batchLabel: "本期新内容（已通过 relevance+quality 双重过滤）",
    });

    ctx.state.insightPayload = insightPayload;

    this.log.log(
      `[${ctx.missionId}] S7 insight: acceptedItems=${acceptedItems.length} signals=${insightPayload.signals.length}`,
    );

    return;
  }
}
