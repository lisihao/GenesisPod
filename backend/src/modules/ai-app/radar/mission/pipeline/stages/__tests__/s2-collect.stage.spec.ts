/**
 * S2 collect — 新源首采回捞窗口（resolveSourceSince）
 *
 * 背景（2026-07-30）：topic 级 since 由 S1 分三档算出（首轮 24h / 定时
 * lastRunAt-5min / 手动 30 天）。往一个已经跑了很久的 topic 里新加源时，该源套用
 * topic 当前窗口——定时档只有 5 分钟，新源存量内容一条都进不来。
 * 规则：source.lastFetchAt 为空 → 用 90 天窗口回捞一次。
 */
import { RadarS2CollectStage, resolveSourceSince } from "../s2-collect.stage";
import { RADAR_FIRST_COLLECTION_LOOKBACK_MS } from "../../../../runtime/radar.constants";
import type {
  CollectorRouter,
  CollectResult,
} from "../../../services/collectors/collector-router.service";
import type { SourceHealthService } from "../../../services/source/source-health.service";
import type {
  RadarMissionContext,
  RadarStageHookArgs,
} from "../radar-stage-types";

const NOW = new Date("2026-07-30T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("resolveSourceSince", () => {
  it("老源（lastFetchAt 有值）沿用 topic 级 since，不受首采窗口影响", () => {
    const topicSince = new Date(NOW.getTime() - 5 * 60 * 1000); // 定时档 5min
    expect(
      resolveSourceSince(
        { lastFetchAt: new Date("2026-07-29T00:00:00Z") },
        topicSince,
        NOW,
      ),
    ).toEqual(topicSince);
  });

  it("新源（lastFetchAt 为空）用 90 天回捞，而非 topic 的 5 分钟窗口", () => {
    const topicSince = new Date(NOW.getTime() - 5 * 60 * 1000);
    const since = resolveSourceSince({ lastFetchAt: null }, topicSince, NOW);
    expect(since).toEqual(
      new Date(NOW.getTime() - RADAR_FIRST_COLLECTION_LOOKBACK_MS),
    );
    // 落在 90 天前那一天（2026-05-01），而不是 5 分钟前
    expect(since.toISOString().slice(0, 10)).toBe("2026-05-01");
  });

  it("topic 窗口比首采窗口更早时取 topic 的，不缩小范围", () => {
    // 假想场景：首采窗口被调小 / topic 手动窗口被调到 180 天
    const topicSince = new Date(NOW.getTime() - 180 * DAY_MS);
    expect(resolveSourceSince({ lastFetchAt: null }, topicSince, NOW)).toEqual(
      topicSince,
    );
  });

  it("首轮 24h 档的新源同样被放宽到 90 天（首轮 topicSince 更晚）", () => {
    const topicSince = new Date(NOW.getTime() - DAY_MS);
    const since = resolveSourceSince({ lastFetchAt: null }, topicSince, NOW);
    expect(since.getTime()).toBeLessThan(topicSince.getTime());
  });

  it("90 天窗口仍是时间窗：更早的低频源不会因此被捞到", () => {
    // karpathy.bearblog.dev 最近一篇 2026-04-30，落在 2026-05-01 之外
    const topicSince = new Date(NOW.getTime() - DAY_MS);
    const since = resolveSourceSince({ lastFetchAt: null }, topicSince, NOW);
    const karpathyLatestPost = new Date("2026-04-30T23:50:33Z");
    expect(karpathyLatestPost.getTime()).toBeLessThan(since.getTime());
  });
});

/**
 * 上游限流 ≠ 源故障（2026-08-11）
 *
 * markFailure 是指数 cooldown，连续 5 次 → FAILING + 24h。GitHub 匿名 Search 配额
 * 只有 10 次/分钟/IP，一个 cron tick 上几个源并发就能撞上——记成源故障会让一次配额
 * 抖动停掉这个源一整天。throttled 只记录错误 + 单独计数，不烧健康度。
 */
describe("RadarS2CollectStage — 限流与故障的区分", () => {
  function makeCtx() {
    return {
      missionId: "m-1",
      userId: "u-1",
      signal: { aborted: false } as AbortSignal,
      input: { topicId: "topic-1" },
      state: {
        sources: [
          {
            id: "s-throttled",
            type: "GITHUB",
            label: "GitHub trending",
            identifier: "trending",
            lastFetchAt: new Date(NOW.getTime() - DAY_MS),
          },
          {
            id: "s-broken",
            type: "RSS",
            label: "Dead feed",
            identifier: "https://example.com/feed.xml",
            lastFetchAt: new Date(NOW.getTime() - DAY_MS),
          },
        ],
        since: new Date(NOW.getTime() - 5 * 60 * 1000),
        metrics: {},
      },
    } as unknown as RadarMissionContext;
  }

  function makeStage(results: CollectResult[]) {
    const health = {
      markFailure: jest.fn().mockResolvedValue(undefined),
      markSuccess: jest.fn().mockResolvedValue(undefined),
    };
    const router = { fanOut: jest.fn().mockResolvedValue(results) };
    const stage = new RadarS2CollectStage(
      router as unknown as CollectorRouter,
      health as unknown as SourceHealthService,
    );
    return { stage, health };
  }

  const throttled: CollectResult = {
    sourceId: "s-throttled",
    type: "GITHUB",
    items: [],
    error: "GitHub API 403 (rate limit exhausted)",
    throttled: true,
    durationMs: 12,
  };
  const broken: CollectResult = {
    sourceId: "s-broken",
    type: "RSS",
    items: [],
    error: "getaddrinfo ENOTFOUND example.com",
    throttled: false,
    durationMs: 34,
  };

  it("被限流的源不进 markFailure，也不冒充成功", async () => {
    const { stage, health } = makeStage([throttled]);
    const ctx = makeCtx();
    await stage.run({} as RadarStageHookArgs, ctx);
    expect(health.markFailure).not.toHaveBeenCalled();
    expect(health.markSuccess).not.toHaveBeenCalled();
    expect(ctx.state.metrics.sourcesThrottled).toBe(1);
    expect(ctx.state.metrics.sourcesFailed).toBe(0);
    // 错误照常上报，不静默吞掉
    expect(ctx.state.metrics.sourceErrors).toEqual([
      { sourceId: "s-throttled", error: throttled.error },
    ]);
  });

  /**
   * 调通但零产出：markSuccess、health 绿、无 error——UI 上和「本期无更新」无法区分。
   * HF 榜单被 publishedAt 窗口筛空就是这么静默过去的，所以必须单独留痕。
   */
  it("调通但零产出的源进 emptySources，且仍算成功（不烧健康度）", async () => {
    const emptyButOk: CollectResult = {
      sourceId: "s-empty",
      type: "HUGGING_FACE",
      items: [],
      error: null,
      throttled: false,
      durationMs: 20,
    };
    const { stage, health } = makeStage([emptyButOk]);
    const ctx = makeCtx();
    ctx.state.sources = [
      {
        id: "s-empty",
        type: "HUGGING_FACE",
        label: "HF trending models",
        identifier: "models",
        lastFetchAt: new Date(NOW.getTime() - DAY_MS),
      },
    ] as unknown as RadarMissionContext["state"]["sources"];

    await stage.run({} as RadarStageHookArgs, ctx);

    expect(health.markSuccess).toHaveBeenCalledWith("s-empty");
    expect(health.markFailure).not.toHaveBeenCalled();
    expect(ctx.state.metrics.sourcesFailed).toBe(0);
    expect(ctx.state.metrics.emptySources).toEqual([
      {
        sourceId: "s-empty",
        label: "HF trending models",
        type: "HUGGING_FACE",
      },
    ]);
  });

  it("有产出的源不进 emptySources", async () => {
    const withItems: CollectResult = {
      sourceId: "s-throttled",
      type: "GITHUB",
      items: [{ externalId: "x" }] as unknown as CollectResult["items"],
      error: null,
      throttled: false,
      durationMs: 20,
    };
    const { stage } = makeStage([withItems]);
    const ctx = makeCtx();
    await stage.run({} as RadarStageHookArgs, ctx);
    expect(ctx.state.metrics.emptySources).toEqual([]);
    expect(ctx.state.metrics.itemsFetched).toBe(1);
  });

  it("真故障仍然烧健康度，两者互不影响", async () => {
    const { stage, health } = makeStage([throttled, broken]);
    const ctx = makeCtx();
    await stage.run({} as RadarStageHookArgs, ctx);
    expect(health.markFailure).toHaveBeenCalledTimes(1);
    expect(health.markFailure).toHaveBeenCalledWith("s-broken", broken.error);
    expect(ctx.state.metrics.sourcesFailed).toBe(1);
    expect(ctx.state.metrics.sourcesThrottled).toBe(1);
    expect(ctx.state.metrics.sourceErrors).toHaveLength(2);
  });
});
