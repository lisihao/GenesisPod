/**
 * analysisMode='on-demand' 的定时链路分流
 *
 * 需求（2026-08-13）：YouTube 大咖主题「每天只采集字幕，不自动分析」。
 * 定时跑保留 S4 相关性（没有它 feed 只能按时间平铺，视频一多没法挑），
 * S5 质量 / S6 实体 / S7 洞察三步 LLM 全部跳过，分析改由用户勾选触发。
 *
 * 同时锁住一条容易被忽略的连带关系：accepted = relevance && quality 的双门槛
 * 在没有 quality 时会恒 false —— feed 的 acceptedOnly 和 radar-signal-search
 * （只查 accepted=true）会一起枯竭。on-demand 主题的 accepted 只看相关性。
 */
import { RadarS5QualityStage } from "../s5-quality.stage";
import { RadarS6EntityStage } from "../s6-entity.stage";
import { RadarS7InsightStage } from "../s7-insight.stage";
import { RadarS8PersistStage } from "../s8-persist.stage";
import { RADAR_PIPELINE_DEFAULTS } from "../../../../runtime/radar.constants";
import type {
  RadarMissionContext,
  RadarStageHookArgs,
} from "../radar-stage-types";

const R = RADAR_PIPELINE_DEFAULTS.acceptedRelevanceMin;
const args = {} as RadarStageHookArgs;

function makeCtx(analysisMode: string): RadarMissionContext {
  return {
    missionId: "m-1",
    userId: "u-1",
    signal: { aborted: false } as AbortSignal,
    input: { topicId: "topic-1" },
    state: {
      topic: {
        id: "topic-1",
        name: "Andrej Karpathy",
        description: null,
        entityType: "person",
        analysisMode,
        refreshCron: "0 */6 * * *",
        lastRunAt: null,
      },
      sources: [
        { id: "s1", type: "YOUTUBE", label: "Karpathy", identifier: "UC..." },
      ],
      newItemIds: ["A"],
      uniqueItems: [
        {
          title: "视频标题",
          content: "字幕全文",
          url: "https://youtu.be/x",
          publishedAt: new Date("2026-08-12T00:00:00Z"),
          sourceId: "s1",
        },
      ],
      relevanceScores: new Map([["A", { score: R + 10, reason: "ok" }]]),
      metrics: {},
    },
  } as unknown as RadarMissionContext;
}

describe("analysisMode=on-demand 定时链路分流", () => {
  it("S5 质量评分不调 LLM，并记进 skippedStages", async () => {
    const chat = { chat: jest.fn() };
    const prisma = {
      radarItem: { update: jest.fn() },
      $transaction: jest.fn(),
    };
    const stage = new RadarS5QualityStage(chat as never, prisma as never);
    const ctx = makeCtx("on-demand");

    await stage.run(args, ctx);

    expect(chat.chat).not.toHaveBeenCalled();
    expect(ctx.state.qualityScores?.size).toBe(0);
    expect(ctx.state.metrics.skippedStages).toContain("s5-quality");
  });

  it("S6 实体抽取不调 LLM", async () => {
    const chat = { chat: jest.fn() };
    const prisma = {
      radarItem: { update: jest.fn() },
      $transaction: jest.fn(),
    };
    const stage = new RadarS6EntityStage(chat as never, prisma as never);
    const ctx = makeCtx("on-demand");

    await stage.run(args, ctx);

    expect(chat.chat).not.toHaveBeenCalled();
    expect(ctx.state.metrics.skippedStages).toContain("s6-entity");
  });

  it("S7 洞察不调 LLM，也不查上期基线", async () => {
    const synthesis = { synthesize: jest.fn() };
    const prisma = { radarInsight: { findFirst: jest.fn() } };
    const stage = new RadarS7InsightStage(synthesis as never, prisma as never);
    const ctx = makeCtx("on-demand");

    await stage.run(args, ctx);

    expect(synthesis.synthesize).not.toHaveBeenCalled();
    expect(prisma.radarInsight.findFirst).not.toHaveBeenCalled();
    expect(ctx.state.insightPayload).toBeUndefined();
    expect(ctx.state.metrics.skippedStages).toContain("s7-insight");
  });

  it("analysisMode=auto 时三步照常跑（不误伤存量主题）", async () => {
    const chat = {
      chat: jest.fn().mockResolvedValue({ content: '{"items":[]}' }),
    };
    const prisma = {
      radarItem: { update: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const stage = new RadarS5QualityStage(chat as never, prisma as never);
    const ctx = makeCtx("auto");

    await stage.run(args, ctx);

    expect(chat.chat).toHaveBeenCalled();
    expect(ctx.state.metrics.skippedStages).toBeUndefined();
  });

  describe("S8 accepted 判定", () => {
    function s8Ctx(analysisMode: string): RadarMissionContext {
      const ctx = makeCtx(analysisMode);
      // 没有 qualityScores —— 正是 on-demand 的常态
      ctx.state.qualityScores = new Map();
      return ctx;
    }

    function makeS8() {
      const updates: Array<{
        where: { id: string };
        data: { accepted: boolean };
      }> = [];
      const prisma = {
        radarItem: {
          update: jest.fn((arg: (typeof updates)[number]) => {
            updates.push(arg);
            return arg;
          }),
        },
        radarInsight: { create: jest.fn() },
        radarTopic: { update: jest.fn().mockResolvedValue({}) },
        $transaction: jest.fn().mockResolvedValue([]),
      };
      const stage = new RadarS8PersistStage();
      (stage as unknown as { prisma: unknown }).prisma = prisma;
      return { stage, prisma, updates };
    }

    it("on-demand：只看相关性就能 accepted（否则 feed/signal-search 全枯竭）", async () => {
      const { stage, updates } = makeS8();
      const ctx = s8Ctx("on-demand");
      await stage.run(args, ctx);
      expect(updates).toEqual([
        { where: { id: "A" }, data: { accepted: true } },
      ]);
      expect(ctx.state.metrics.itemsAccepted).toBe(1);
    });

    it("auto：缺质量分仍然不 accepted（存量双门槛不变）", async () => {
      const { stage, updates } = makeS8();
      const ctx = s8Ctx("auto");
      await stage.run(args, ctx);
      expect(updates).toEqual([
        { where: { id: "A" }, data: { accepted: false } },
      ]);
      expect(ctx.state.metrics.itemsAccepted).toBe(0);
    });
  });
});
