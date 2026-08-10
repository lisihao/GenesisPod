import { RadarSource } from "@prisma/client";
import modelFixture = require("../__fixtures__/hugging-face-models.json");
import paperFixture = require("../__fixtures__/hugging-face-papers.json");
import { HuggingFaceCollector } from "../hugging-face-collector.service";

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
});
