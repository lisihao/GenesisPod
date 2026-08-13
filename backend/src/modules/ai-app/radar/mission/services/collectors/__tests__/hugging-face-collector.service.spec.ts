import { RadarSource } from "@prisma/client";
import modelFixture = require("../__fixtures__/hugging-face-models.json");
import paperFixture = require("../__fixtures__/hugging-face-papers.json");
import { HuggingFaceCollector } from "../hugging-face-collector.service";
import { CollectorThrottleError } from "../icollector";

function source(identifier: string) {
  return { identifier, config: null } as RadarSource;
}

const context = {
  since: new Date("2026-08-01T00:00:00Z"),
  perSourceLimit: 10,
  userId: "user-1",
};

describe("HuggingFaceCollector", () => {
  afterEach(() => jest.restoreAllMocks());

  it("maps trending models with canonical model evidence", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(modelFixture), { status: 200 }),
      );
    const items = await new HuggingFaceCollector().fetch(
      source("models:research"),
      context,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      externalId: "model:genesispod/research-model",
      url: "https://huggingface.co/genesispod/research-model",
      metrics: { downloads: 12000, likes: 320, trendingScore: 88 },
      raw: {
        provider: "hugging_face",
        kind: "model",
        evidence: { externalId: "genesispod/research-model" },
      },
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("search=research");
  });

  it("maps daily papers and preserves GitHub/project evidence links", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(paperFixture), { status: 200 }),
      );
    const items = await new HuggingFaceCollector().fetch(
      source("papers"),
      context,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      externalId: "paper:2608.00001",
      author: "Ada Example",
      metrics: { upvotes: 54, comments: 7, githubStars: 900 },
      raw: {
        provider: "hugging_face",
        kind: "paper",
        evidence: {
          externalId: "2608.00001",
          githubRepo: "https://github.com/example/evidence",
          projectPage: "https://example.org/evidence",
        },
      },
    });
  });

  it("surfaces provider errors", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("{}", { status: 503 }));
    await expect(
      new HuggingFaceCollector().fetch(source("models"), context),
    ).rejects.toThrow("Hugging Face API 503");
  });

  it("reports upstream 429 as throttling so source health is not burned", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("{}", { status: 429 }));
    await expect(
      new HuggingFaceCollector().fetch(source("models"), context),
    ).rejects.toBeInstanceOf(CollectorThrottleError);
  });

  /**
   * 回归护栏（2026-08-11）：/api/models 默认响应没有 lastModified，publishedAt 落到
   * createdAt（模型创建时间）；daily_papers 的 publishedAt 是 arXiv 首发日。两者都不是
   * 「本次才上榜」，拿它当增量窗口会把榜单筛空——定时档窗口只有 5 分钟。
   * 增量语义由 S3 的 (topicId, externalId) dedupe 负责，这里必须原样返回。
   */
  it("keeps trending entries whose upstream timestamp predates the window", async () => {
    const staleTrendingModel = [
      {
        _id: "stale-id",
        id: "genesispod/long-lived-model",
        modelId: "genesispod/long-lived-model",
        author: "genesispod",
        downloads: 900_000,
        likes: 5_000,
        trendingScore: 1_200,
        // 半年前建的模型，今天照样在 trending 榜首
        createdAt: "2026-02-01T00:00:00Z",
      },
    ];
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(staleTrendingModel), { status: 200 }),
      );
    const items = await new HuggingFaceCollector().fetch(
      source("models"),
      context,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.externalId).toBe("model:genesispod/long-lived-model");
  });

  it("still honours perSourceLimit after dropping the window filter", async () => {
    const payload = Array.from({ length: 5 }, (_, i) => ({
      _id: `id-${i}`,
      id: `genesispod/model-${i}`,
      modelId: `genesispod/model-${i}`,
      createdAt: "2026-02-01T00:00:00Z",
    }));
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
    const items = await new HuggingFaceCollector().fetch(source("models"), {
      ...context,
      perSourceLimit: 2,
    });
    expect(items).toHaveLength(2);
  });
});
