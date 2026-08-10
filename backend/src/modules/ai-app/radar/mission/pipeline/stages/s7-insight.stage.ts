/**
 * S7 — signal insight synthesis stage adapter
 *
 * primitive=synthesize, roleId=signal-analyst, stateful=true
 *
 * 输入：ctx.state（含 topic / uniqueItems / relevanceScores / qualityScores / entityMap）
 * + 上期 RadarInsight（按 topicId 查最近 1 条，用于对照分析）。
 *
 * 只用 accepted 条件（relevance>=60 && quality>=50）的 item 喂 LLM。
 * 单次 LLM 调用，生成：
 *   - summary ≤200 字中文
 *   - highlights 3-5 条
 *   - signals 0-5 条
 *   - topEntities top 8
 *
 * 结果写入 ctx.state.insightPayload（不写 DB，由 s8 写库）。
 */
import { Injectable, Logger } from "@nestjs/common";
import { AIModelType } from "@prisma/client";
import { AiChatService } from "@/modules/ai-engine/facade";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RADAR_PIPELINE_DEFAULTS } from "../../../runtime/radar.constants";
import type {
  RadarInsightPayload,
  RadarMissionContext,
  RadarStageHookArgs,
  RadarStageRunner,
} from "./radar-stage-types";

@Injectable()
export class RadarS7InsightStage implements RadarStageRunner {
  private readonly log = new Logger(RadarS7InsightStage.name);

  constructor(
    private readonly chat: AiChatService,
    private readonly prisma: PrismaService,
  ) {}

  async run(args: RadarStageHookArgs, ctx: RadarMissionContext): Promise<void> {
    if (ctx.signal.aborted) throw new Error("aborted_during_insight_synthesis");

    const topic = ctx.state.topic;
    if (!topic) throw new Error("S7 insight: ctx.state.topic 缺失");

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

    const acceptedItems = uniqueItems
      .map((raw, idx) => ({
        id: newItemIds[idx],
        title: raw.title ?? "",
        content: raw.content ?? "",
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

    // 查上期 insight（对照分析用）
    const prevInsight = await this.prisma.radarInsight.findFirst({
      where: { topicId: topic.id },
      orderBy: { periodTo: "desc" },
    });

    const systemPrompt =
      args.systemPrompt ||
      "你是 AI 雷达的信号分析师，结合本期新动态与历史基线，生成结构化洞察报告。";

    // 构建实体频率统计（从 entityMap 统计各实体出现次数）
    const entityFreq = buildEntityFreq(
      entityMap,
      acceptedItems.map((i) => i.id),
    );

    if (ctx.signal.aborted) throw new Error("aborted_during_insight_synthesis");

    const insightPayload = await this.synthesize(
      systemPrompt,
      topic,
      acceptedItems,
      qualityScores,
      entityFreq,
      prevInsight,
      ctx.userId,
    );

    ctx.state.insightPayload = insightPayload;

    this.log.log(
      `[${ctx.missionId}] S7 insight: acceptedItems=${acceptedItems.length} signals=${insightPayload.signals.length}`,
    );

    return;
  }

  private async synthesize(
    systemPrompt: string,
    topic: NonNullable<RadarMissionContext["state"]["topic"]>,
    acceptedItems: Array<{
      id: string;
      title: string;
      content: string;
      url: string;
      publishedAt: Date;
      sourceId: string;
      sourceType: string;
      sourceLabel: string;
      author: string | null;
    }>,
    qualityScores: Map<string, { score: number; summary: string }>,
    entityFreq: Array<{ type: string; name: string; mentions: number }>,
    prevInsight: { summary: string; periodFrom: Date; periodTo: Date } | null,
    userId: string,
  ): Promise<RadarInsightPayload> {
    // 构建 item 摘要列表（用 aiSummary 减少 token 消耗）
    const itemDigests = acceptedItems.slice(0, 30).map((item) => ({
      id: item.id,
      title: truncate(item.title, 120),
      summary: truncate(
        qualityScores.get(item.id)?.summary ?? item.content,
        200,
      ),
      url: item.url,
      publishedAt: item.publishedAt.toISOString().slice(0, 10),
      source: item.sourceId,
      sourceId: item.sourceId,
      sourceType: item.sourceType,
      sourceLabel: item.sourceLabel,
      author: item.author,
    }));

    const userPrompt = `主题：${JSON.stringify({
      name: topic.name,
      description: truncate(topic.description ?? "", 300),
      entityType: topic.entityType ?? null,
    })}

${buildInsightModeInstructions(topic.entityType, itemDigests)}

本期新内容（${itemDigests.length} 条，已通过 relevance+quality 双重过滤）：
${itemDigests.map((d) => JSON.stringify(d)).join("\n")}

本期高频实体 Top 15：
${entityFreq
  .slice(0, 15)
  .map((e) => `${e.type}:${e.name}(${e.mentions}次)`)
  .join(" / ")}

${
  prevInsight
    ? `上期摘要（${prevInsight.periodFrom.toISOString().slice(0, 10)} ~ ${prevInsight.periodTo.toISOString().slice(0, 10)}）：
${truncate(prevInsight.summary, 300)}`
    : "无历史基线（首次运行）"
}

请生成结构化洞察报告，严格按以下 JSON schema 返回（无 markdown 围栏）：
{
  "summary": "≤200 字中文总结",
  "highlights": [
    { "title": "高亮标题", "itemIds": ["<id1>", "<id2>"], "type": "trend|new-entity|anomaly|key-event" }
  ],
  "signals": [
    { "kind": "信号类型", "magnitude": 0-10, "evidence": "≤100 字佐证", "itemIds": ["<id1>"] }
  ],
  "topEntities": [
    { "type": "person|company|...", "name": "实体名", "mentions": 5, "delta": 2 }
  ]
}

要求：highlights 3-5 条；signals 0-5 条；topEntities 最多 8 个（按 mentions 降序）。highlights 和 signals 的 itemIds 只能引用上面真实存在的内容 id。`;

    try {
      const result = await this.chat.chat({
        systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        modelType: AIModelType.CHAT,
        taskProfile: {
          creativity: "low",
          outputLength: "medium",
        },
        userId,
        operationName: "radar.s7-insight",
        skipGuardrails: true,
      });

      const parsed = tryParseJson<RadarInsightPayload>(result.content);
      if (!parsed || typeof parsed.summary !== "string") {
        this.log.warn("Insight LLM unparseable, building minimal fallback");
        return buildFallbackInsight(itemDigests.length);
      }

      return {
        summary: truncate(parsed.summary ?? "", 200),
        highlights: normalizeHighlights(parsed.highlights),
        signals: normalizeSignals(
          parsed.signals,
          new Set(itemDigests.map((item) => item.id)),
          topic.entityType === "person",
        ),
        topEntities: normalizeTopEntities(parsed.topEntities, entityFreq),
      };
    } catch (err) {
      this.log.error(`S7 insight LLM err: ${(err as Error).message}`);
      return buildFallbackInsight(itemDigests.length);
    }
  }
}

// ---- 辅助函数 ----

function buildEntityFreq(
  entityMap: Map<
    string,
    { type: string; name: string; normalizedName: string; confidence: number }[]
  >,
  acceptedIds: string[],
): Array<{ type: string; name: string; mentions: number }> {
  const freq = new Map<
    string,
    { type: string; name: string; mentions: number }
  >();
  const idSet = new Set(acceptedIds);
  for (const [itemId, entities] of entityMap) {
    if (!idSet.has(itemId)) continue;
    for (const entity of entities) {
      const key = `${entity.type}:${entity.normalizedName}`;
      const existing = freq.get(key);
      if (existing) {
        existing.mentions += 1;
      } else {
        freq.set(key, { type: entity.type, name: entity.name, mentions: 1 });
      }
    }
  }
  return [...freq.values()].sort((a, b) => b.mentions - a.mentions);
}

function normalizeHighlights(raw: unknown): RadarInsightPayload["highlights"] {
  if (!Array.isArray(raw)) return [];
  const VALID_TYPES = new Set(["trend", "new-entity", "anomaly", "key-event"]);
  return raw
    .slice(0, 5)
    .filter(
      (h): h is Record<string, unknown> => h !== null && typeof h === "object",
    )
    .map((h) => ({
      title: truncate(String(h["title"] ?? ""), 100),
      itemIds: Array.isArray(h["itemIds"])
        ? (h["itemIds"] as unknown[])
            .filter((v): v is string => typeof v === "string")
            .slice(0, 10)
        : [],
      type: (VALID_TYPES.has(String(h["type"])) ? h["type"] : "trend") as
        | "trend"
        | "new-entity"
        | "anomaly"
        | "key-event",
    }));
}

function normalizeSignals(
  raw: unknown,
  allowedItemIds: ReadonlySet<string>,
  requireEvidenceLinks: boolean,
): RadarInsightPayload["signals"] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 5)
    .filter(
      (s): s is Record<string, unknown> => s !== null && typeof s === "object",
    )
    .map((s) => {
      const itemIds = Array.isArray(s["itemIds"])
        ? (s["itemIds"] as unknown[])
            .filter(
              (id): id is string =>
                typeof id === "string" && allowedItemIds.has(id),
            )
            .slice(0, 10)
        : [];
      return {
        kind: truncate(String(s["kind"] ?? "unknown"), 60),
        magnitude: clampMagnitude(s["magnitude"]),
        evidence: truncate(String(s["evidence"] ?? ""), 100),
        ...(itemIds.length > 0 ? { itemIds } : {}),
      };
    })
    .filter((signal) => !requireEvidenceLinks || signal.itemIds?.length);
}

export function buildInsightModeInstructions(
  entityType: string | null,
  items: Array<{ sourceType: string }>,
): string {
  if (entityType !== "person") return "分析模式：主题趋势洞察。";
  const sourceTypes = [...new Set(items.map((item) => item.sourceType))].sort();
  return `分析模式：人物（大咖）跨来源洞察。
- 已覆盖平台：${sourceTypes.join(", ") || "UNKNOWN"}；覆盖少于 2 个平台时必须明确标注“单一来源，不足以交叉验证”。
- 分别分析：观点变化、公开项目/模型/代码活动、视频表达、时间线与异常信号。
- 区分本人一手陈述、平台行为指标和第三方转述，不得把推断写成事实。
- 每个 highlight 与 signal 必须用 itemIds 绑定真实证据；没有证据 id 的信号必须省略。
- 跨平台一致或矛盾的结论，至少引用来自两个不同 sourceType 的 itemIds。`;
}

function normalizeTopEntities(
  raw: unknown,
  entityFreq: Array<{ type: string; name: string; mentions: number }>,
): RadarInsightPayload["topEntities"] {
  if (!Array.isArray(raw) || raw.length === 0) {
    // LLM 没返回 → 从 entityFreq 构建兜底
    return entityFreq.slice(0, 8).map((e) => ({
      type: e.type,
      name: e.name,
      mentions: e.mentions,
      delta: 0,
    }));
  }
  return raw
    .slice(0, 8)
    .filter(
      (e): e is Record<string, unknown> => e !== null && typeof e === "object",
    )
    .map((e) => ({
      type: truncate(String(e["type"] ?? "other"), 30),
      name: truncate(String(e["name"] ?? ""), 100),
      mentions:
        typeof e["mentions"] === "number" && Number.isFinite(e["mentions"])
          ? Math.max(0, Math.round(e["mentions"]))
          : 0,
      delta:
        typeof e["delta"] === "number" && Number.isFinite(e["delta"])
          ? Math.round(e["delta"])
          : 0,
    }));
}

function buildFallbackInsight(itemCount: number): RadarInsightPayload {
  return {
    summary: `本期共处理 ${itemCount} 条内容，LLM 洞察生成失败，请稍后重新运行。`,
    highlights: [],
    signals: [],
    topEntities: [],
  };
}

function clampMagnitude(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 5;
  return Math.max(0, Math.min(10, Math.round(v)));
}

function tryParseJson<T>(raw: string): T | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  const firstBrace = stripped.search(/[{[]/);
  const candidate = firstBrace >= 0 ? stripped.slice(firstBrace) : stripped;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 3)) + "...";
}
