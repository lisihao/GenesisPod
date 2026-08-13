/**
 * RadarInsightSynthesisService —— 洞察合成的唯一实现
 *
 * 两个调用方共用同一套 prompt + 证据门禁，不允许各写一份：
 *   1. S7 stage —— 定时 refresh mission 的周期洞察（kind='scheduled'）
 *   2. AdHocInsightService —— 用户在 feed 勾选一批 item 触发的分析（kind='ad-hoc'）
 *
 * 证据门禁：highlights 与 signals 的 itemIds 都只能引用本次真实存在的 item id；
 * person 主题下，**剔完假 id 后没有证据的结论整条丢弃**（highlight 和 signal 一视同仁
 * —— 只删 id 会留下「有论点、无出处」的结论，比不显示更糟）。丢弃数单独计数并打日志：
 * 否则前端只看到「0 条信号」，分不清是模型没给 id 还是本期真没信号。
 */
import { Injectable, Logger } from "@nestjs/common";
import { AIModelType } from "@prisma/client";
import { AiChatService } from "@/modules/ai-engine/facade";
import type { RadarInsightPayload } from "../../pipeline/stages/radar-stage-types";

/** 喂给 LLM 的单条内容（S7 从 ctx.state 组装，ad-hoc 从 DB 组装） */
export interface InsightSynthesisItem {
  id: string;
  title: string;
  /** 正文或字幕全文；有 aiSummary 时由调用方优先传摘要以省 token */
  summary: string;
  url: string;
  publishedAt: Date;
  sourceId: string;
  sourceType: string;
  sourceLabel: string;
  author: string | null;
}

export interface InsightSynthesisInput {
  systemPrompt: string;
  topic: {
    name: string;
    description: string | null;
    entityType: string | null;
  };
  items: InsightSynthesisItem[];
  entityFreq: Array<{ type: string; name: string; mentions: number }>;
  prevInsight: { summary: string; periodFrom: Date; periodTo: Date } | null;
  userId: string;
  /** 计费/追踪用，如 radar.s7-insight / radar.ad-hoc-insight */
  operationName: string;
  /** 本批内容的来历描述，进 prompt（如「本期新内容」/「用户手动选中的内容」） */
  batchLabel: string;
}

/** 单次喂给 LLM 的最大条数 —— 与 S7 原实现一致 */
export const INSIGHT_MAX_ITEMS = 30;

@Injectable()
export class RadarInsightSynthesisService {
  private readonly log = new Logger(RadarInsightSynthesisService.name);

  constructor(private readonly chat: AiChatService) {}

  async synthesize(input: InsightSynthesisInput): Promise<RadarInsightPayload> {
    const { topic, items, entityFreq, prevInsight } = input;
    const itemDigests = items.slice(0, INSIGHT_MAX_ITEMS).map((item) => ({
      id: item.id,
      title: truncate(item.title, 120),
      summary: truncate(item.summary, 200),
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

${input.batchLabel}（${itemDigests.length} 条）：
${itemDigests.map((d) => JSON.stringify(d)).join("\n")}

本批高频实体 Top 15：
${
  entityFreq
    .slice(0, 15)
    .map((e) => `${e.type}:${e.name}(${e.mentions}次)`)
    .join(" / ") || "（未做实体抽取）"
}

${
  prevInsight
    ? `上期摘要（${prevInsight.periodFrom.toISOString().slice(0, 10)} ~ ${prevInsight.periodTo.toISOString().slice(0, 10)}）：
${truncate(prevInsight.summary, 300)}`
    : "无历史基线"
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
        systemPrompt: input.systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        modelType: AIModelType.CHAT,
        taskProfile: { creativity: "low", outputLength: "medium" },
        userId: input.userId,
        operationName: input.operationName,
        skipGuardrails: true,
      });

      const parsed = tryParseJson<RadarInsightPayload>(result.content);
      if (!parsed || typeof parsed.summary !== "string") {
        this.log.warn("Insight LLM unparseable, building minimal fallback");
        return buildFallbackInsight(itemDigests.length);
      }

      const allowedItemIds = new Set(itemDigests.map((item) => item.id));
      const requireEvidenceLinks = topic.entityType === "person";
      const highlights = normalizeHighlights(
        parsed.highlights,
        allowedItemIds,
        requireEvidenceLinks,
      );
      const signals = normalizeSignals(
        parsed.signals,
        allowedItemIds,
        requireEvidenceLinks,
      );

      // 只报证据门禁删掉的那一份：slice(0,5) 截断和非对象过滤不算在内，
      // 否则「模型多给了 3 条」会被误报成「3 条缺证据」。
      const dropped =
        highlights.droppedForEvidence + signals.droppedForEvidence;
      if (dropped > 0) {
        this.log.warn(
          `${input.operationName}: 证据门禁丢弃 ${dropped} 条结论` +
            `（highlight ${highlights.droppedForEvidence} / signal ${signals.droppedForEvidence}，` +
            `entityType=${topic.entityType ?? "null"}）——模型未给出可核对的 itemIds`,
        );
      }

      return {
        summary: truncate(parsed.summary ?? "", 200),
        highlights: highlights.kept,
        signals: signals.kept,
        topEntities: normalizeTopEntities(parsed.topEntities, entityFreq),
      };
    } catch (err) {
      this.log.error(
        `${input.operationName} LLM err: ${(err as Error).message}`,
      );
      return buildFallbackInsight(itemDigests.length);
    }
  }
}

// ---- 纯函数（导出供 stage 与单测复用） ----

export function buildEntityFreq(
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

/**
 * 证据门禁的结果：留下的条目 + **仅因缺少有效证据 id 被删掉**的条数。
 *
 * 单独返回计数是因为「进来多少 - 出去多少」不等于「被门禁删了多少」：
 * slice(0,5) 的截断和非对象过滤也会让数量变少，混在一起报会把截断说成证据不足。
 */
export interface EvidenceGateResult<T> {
  kept: T[];
  droppedForEvidence: number;
}

const VALID_HIGHLIGHT_TYPES = new Set([
  "trend",
  "new-entity",
  "anomaly",
  "key-event",
]);

function pickAllowedItemIds(
  raw: unknown,
  allowedItemIds: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter((v): v is string => typeof v === "string" && allowedItemIds.has(v))
    .slice(0, 10);
}

/**
 * highlights 与 signals 同一套证据规则：
 *  - itemIds 只能引用本批真实存在的 id（模型编的一律剔除）
 *  - person 主题下，**剔完 id 后没有证据的结论整条删掉**——只删 id 会留下一条
 *    「有论点、无出处」的高亮，比不显示更糟：它看起来仍然是有依据的结论。
 */
export function normalizeHighlights(
  raw: unknown,
  allowedItemIds: ReadonlySet<string>,
  requireEvidenceLinks: boolean,
): EvidenceGateResult<RadarInsightPayload["highlights"][number]> {
  if (!Array.isArray(raw)) return { kept: [], droppedForEvidence: 0 };
  const candidates = raw
    .slice(0, 5)
    .filter(
      (h): h is Record<string, unknown> => h !== null && typeof h === "object",
    )
    .map((h) => ({
      title: truncate(String(h["title"] ?? ""), 100),
      itemIds: pickAllowedItemIds(h["itemIds"], allowedItemIds),
      type: (VALID_HIGHLIGHT_TYPES.has(String(h["type"]))
        ? h["type"]
        : "trend") as "trend" | "new-entity" | "anomaly" | "key-event",
    }));
  if (!requireEvidenceLinks) {
    return { kept: candidates, droppedForEvidence: 0 };
  }
  const kept = candidates.filter((h) => h.itemIds.length > 0);
  return { kept, droppedForEvidence: candidates.length - kept.length };
}

export function normalizeSignals(
  raw: unknown,
  allowedItemIds: ReadonlySet<string>,
  requireEvidenceLinks: boolean,
): EvidenceGateResult<RadarInsightPayload["signals"][number]> {
  if (!Array.isArray(raw)) return { kept: [], droppedForEvidence: 0 };
  const candidates = raw
    .slice(0, 5)
    .filter(
      (s): s is Record<string, unknown> => s !== null && typeof s === "object",
    )
    .map((s) => {
      const itemIds = pickAllowedItemIds(s["itemIds"], allowedItemIds);
      return {
        kind: truncate(String(s["kind"] ?? "unknown"), 60),
        magnitude: clampMagnitude(s["magnitude"]),
        evidence: truncate(String(s["evidence"] ?? ""), 100),
        ...(itemIds.length > 0 ? { itemIds } : {}),
      };
    });
  if (!requireEvidenceLinks) {
    return { kept: candidates, droppedForEvidence: 0 };
  }
  const kept = candidates.filter((signal) => signal.itemIds?.length);
  return { kept, droppedForEvidence: candidates.length - kept.length };
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
- 每个 highlight 与 signal 必须用 itemIds 绑定真实证据；**没有有效 itemIds 的高亮和信号会被系统整条丢弃**，宁可少写也不要写没出处的结论。
- 跨平台一致或矛盾的结论，至少引用来自两个不同 sourceType 的 itemIds。`;
}

export function normalizeTopEntities(
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

export function buildFallbackInsight(itemCount: number): RadarInsightPayload {
  return {
    summary: `本期共处理 ${itemCount} 条内容，LLM 洞察生成失败，请稍后重新运行。`,
    highlights: [],
    signals: [],
    topEntities: [],
  };
}

export function clampMagnitude(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 5;
  return Math.max(0, Math.min(10, Math.round(v)));
}

export function tryParseJson<T>(raw: string): T | null {
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

export function truncate(s: string, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 3)) + "...";
}
