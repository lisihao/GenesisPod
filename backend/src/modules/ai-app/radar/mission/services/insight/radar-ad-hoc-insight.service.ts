/**
 * RadarAdHocInsightService —— 用户勾选一批 item 触发的按需分析
 *
 * 与 S7 周期洞察的区别只有输入来源和范围界定：
 *   S7      从 ctx.state 拿本轮 accepted item，范围 = periodFrom~periodTo
 *   ad-hoc  从 DB 按 itemIds 拿用户勾选的 item，范围 = itemIds 本身
 * 合成逻辑、prompt、证据门禁全部共用 RadarInsightSynthesisService。
 *
 * 鉴权：topic 必须属于调用者（行级），itemIds 必须全部属于该 topic——
 * 不信任前端传来的任何归属信息。
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SkillLoaderService } from "@/modules/ai-engine/facade";
import {
  buildEntityFreq,
  INSIGHT_MAX_ITEMS,
  RadarInsightSynthesisService,
  type InsightSynthesisItem,
} from "./radar-insight-synthesis.service";
import type { RadarExtractedEntity } from "../../pipeline/stages/radar-stage-types";

/** 一次手动分析最多喂多少条 —— 与 S7 单次上限一致，避免 prompt 爆掉 */
export const AD_HOC_MAX_ITEMS = INSIGHT_MAX_ITEMS;

export interface AdHocInsightResult {
  insightId: string;
  itemCount: number;
  summary: string;
  highlights: unknown;
  signals: unknown;
  topEntities: unknown;
  createdAt: Date;
}

@Injectable()
export class RadarAdHocInsightService {
  private readonly log = new Logger(RadarAdHocInsightService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly synthesis: RadarInsightSynthesisService,
    private readonly skillLoader: SkillLoaderService,
  ) {}

  async analyze(
    userId: string,
    topicId: string,
    itemIds: string[],
  ): Promise<AdHocInsightResult> {
    const uniqueIds = [...new Set(itemIds)];
    if (uniqueIds.length > AD_HOC_MAX_ITEMS) {
      throw new BadRequestException(
        `一次最多分析 ${AD_HOC_MAX_ITEMS} 条内容，本次选中 ${uniqueIds.length} 条`,
      );
    }

    const topic = await this.prisma.radarTopic.findFirst({
      where: { id: topicId, userId },
    });
    if (!topic) throw new NotFoundException("主题不存在或无权访问");

    // 只取属于该 topic 的 item：前端传来的 id 一律不信任
    const rows = await this.prisma.radarItem.findMany({
      where: { id: { in: uniqueIds }, topicId },
      include: {
        source: {
          select: { id: true, type: true, label: true, identifier: true },
        },
      },
      orderBy: { publishedAt: "desc" },
    });

    if (rows.length === 0) {
      throw new BadRequestException("选中的内容不存在或不属于该主题");
    }
    if (rows.length < uniqueIds.length) {
      // 不静默吞掉：少了几条要让用户知道，否则「分析了 10 条」其实只分析了 7 条
      this.log.warn(
        `ad-hoc insight topic=${topicId}: 选中 ${uniqueIds.length} 条，实际可用 ${rows.length} 条（其余不存在或不属于该主题）`,
      );
    }

    const items: InsightSynthesisItem[] = rows.map((row) => ({
      id: row.id,
      title: row.title ?? "",
      // 手动分析的价值恰恰在正文/字幕本身，aiSummary（若有）只作兜底
      summary: row.content ?? row.aiSummary ?? "",
      url: row.url ?? "",
      publishedAt: row.publishedAt,
      sourceId: row.sourceId,
      sourceType: row.source?.type ?? "UNKNOWN",
      sourceLabel:
        row.source?.label?.trim() || row.source?.identifier || row.sourceId,
      author: row.author,
    }));

    // 已有实体的 item（auto 主题跑过 S6）复用；on-demand 主题这里通常为空，
    // 由 normalizeTopEntities 回落到 LLM 输出。
    const entityMap = new Map<string, RadarExtractedEntity[]>(
      rows
        .filter((row) => Array.isArray(row.entities))
        .map((row) => [
          row.id,
          row.entities as unknown as RadarExtractedEntity[],
        ]),
    );
    const entityFreq = buildEntityFreq(
      entityMap,
      items.map((i) => i.id),
    );

    const skill = await this.skillLoader.getSkillById(
      "ai-radar.signal-analyst",
    );
    const systemPrompt =
      skill?.content ||
      "你是 AI 雷达的信号分析师，针对用户选中的一组内容生成结构化洞察报告。";

    const payload = await this.synthesis.synthesize({
      systemPrompt,
      topic: {
        name: topic.name,
        description: topic.description,
        entityType: topic.entityType,
      },
      items,
      entityFreq,
      // 手动分析是「这几条说了什么」，不做跨期对照——塞上期摘要只会诱导模型
      // 把没选中的内容写进结论。
      prevInsight: null,
      userId,
      operationName: "radar.ad-hoc-insight",
      batchLabel: "用户选中的内容",
    });

    // 范围由 itemIds 界定；periodFrom/To 取选集的真实时间跨度，纯粹为了让
    // 既有按时间排序的查询/UI 不至于拿到空值。
    const publishedTimes = rows.map((r) => r.publishedAt.getTime());
    const insight = await this.prisma.radarInsight.create({
      data: {
        topicId,
        kind: "ad-hoc",
        itemIds: items.map((i) => i.id) as unknown as Prisma.InputJsonValue,
        periodFrom: new Date(Math.min(...publishedTimes)),
        periodTo: new Date(Math.max(...publishedTimes)),
        summary: payload.summary,
        highlights: payload.highlights as unknown as Prisma.InputJsonValue,
        signals: payload.signals as unknown as Prisma.InputJsonValue,
        topEntities: payload.topEntities as unknown as Prisma.InputJsonValue,
      },
    });

    this.log.log(
      `ad-hoc insight created topic=${topicId} insight=${insight.id} items=${items.length} signals=${payload.signals.length}`,
    );

    return {
      insightId: insight.id,
      itemCount: items.length,
      summary: insight.summary,
      highlights: insight.highlights,
      signals: insight.signals,
      topEntities: insight.topEntities,
      createdAt: insight.createdAt,
    };
  }
}
