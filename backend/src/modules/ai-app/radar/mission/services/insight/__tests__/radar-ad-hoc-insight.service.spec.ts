/**
 * RadarAdHocInsightService —— 用户勾选一批 item 触发的按需分析
 *
 * 锁住的行为：
 *  - 归属校验：itemIds 只认真正属于该 topic 的（前端传什么都不信）
 *  - topic 不属于调用者 → NotFound
 *  - 超过单次上限 → BadRequest（不静默截断）
 *  - 产物是 kind='ad-hoc' + itemIds 的 RadarInsight
 *  - 不拿上期洞察当基线（会诱导模型把没选中的内容写进结论）
 */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  AD_HOC_MAX_ITEMS,
  RadarAdHocInsightService,
} from "../radar-ad-hoc-insight.service";

const TOPIC = {
  id: "topic-1",
  userId: "u-1",
  name: "Andrej Karpathy",
  description: null,
  entityType: "person",
};

function makeRow(id: string) {
  return {
    id,
    title: `视频 ${id}`,
    content: "字幕全文",
    aiSummary: null,
    url: `https://youtu.be/${id}`,
    publishedAt: new Date("2026-08-12T00:00:00Z"),
    sourceId: "s1",
    author: "Karpathy",
    entities: null,
    source: {
      id: "s1",
      type: "YOUTUBE",
      label: "Karpathy 频道",
      identifier: "UC...",
    },
  };
}

function makeService(
  rows: ReturnType<typeof makeRow>[],
  topic: unknown = TOPIC,
) {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    radarTopic: { findFirst: jest.fn().mockResolvedValue(topic) },
    radarItem: { findMany: jest.fn().mockResolvedValue(rows) },
    radarInsight: {
      create: jest.fn((arg: { data: Record<string, unknown> }) => {
        created.push(arg.data);
        return Promise.resolve({
          id: "insight-1",
          createdAt: new Date("2026-08-13T00:00:00Z"),
          ...arg.data,
        });
      }),
    },
  };
  const synthesis = {
    synthesize: jest.fn().mockResolvedValue({
      summary: "这批视频集中讨论了训练成本",
      highlights: [{ title: "h", itemIds: ["A"], type: "trend" }],
      signals: [{ kind: "观点", magnitude: 6, evidence: "e", itemIds: ["A"] }],
      topEntities: [],
    }),
  };
  const skillLoader = {
    getSkillById: jest.fn().mockResolvedValue({ content: "SKILL" }),
  };
  const service = new RadarAdHocInsightService(
    prisma as never,
    synthesis as never,
    skillLoader as never,
  );
  return { service, prisma, synthesis, created };
}

describe("RadarAdHocInsightService", () => {
  it("写入 kind='ad-hoc' + itemIds，范围由选集界定", async () => {
    const { service, created, prisma } = makeService([
      makeRow("A"),
      makeRow("B"),
    ]);

    const result = await service.analyze("u-1", "topic-1", ["A", "B"]);

    expect(prisma.radarItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["A", "B"] }, topicId: "topic-1" },
      }),
    );
    expect(created[0]).toMatchObject({
      topicId: "topic-1",
      kind: "ad-hoc",
      itemIds: ["A", "B"],
      summary: "这批视频集中讨论了训练成本",
    });
    expect(result.itemCount).toBe(2);
    expect(result.insightId).toBe("insight-1");
  });

  it("不拿上期洞察当基线", async () => {
    const { service, synthesis } = makeService([makeRow("A")]);
    await service.analyze("u-1", "topic-1", ["A"]);
    expect(synthesis.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        prevInsight: null,
        operationName: "radar.ad-hoc-insight",
      }),
    );
  });

  it("只分析真正属于该主题的 item（多传的 id 被丢弃，不报成功数）", async () => {
    // DB 只回 A：B 不属于该 topic
    const { service, created } = makeService([makeRow("A")]);
    const result = await service.analyze("u-1", "topic-1", ["A", "B"]);
    expect(result.itemCount).toBe(1);
    expect(created[0].itemIds).toEqual(["A"]);
  });

  it("topic 不属于调用者 → NotFound", async () => {
    const { service } = makeService([makeRow("A")], null);
    await expect(
      service.analyze("u-other", "topic-1", ["A"]),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("超过单次上限 → BadRequest（不静默截断）", async () => {
    const { service, synthesis } = makeService([makeRow("A")]);
    const tooMany = Array.from(
      { length: AD_HOC_MAX_ITEMS + 1 },
      (_, i) => `id-${i}`,
    );
    await expect(
      service.analyze("u-1", "topic-1", tooMany),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(synthesis.synthesize).not.toHaveBeenCalled();
  });

  it("选中的 item 一条都不存在 → BadRequest，不写空洞察", async () => {
    const { service, prisma } = makeService([]);
    await expect(
      service.analyze("u-1", "topic-1", ["ghost"]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.radarInsight.create).not.toHaveBeenCalled();
  });
});
