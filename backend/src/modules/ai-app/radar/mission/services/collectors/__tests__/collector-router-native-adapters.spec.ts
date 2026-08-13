import { RadarSource } from "@prisma/client";
import { CollectorRouter } from "../collector-router.service";
import { GithubCollector } from "../github-collector.service";
import { HuggingFaceCollector } from "../hugging-face-collector.service";
import githubFixture = require("../__fixtures__/github-search.json");
import modelFixture = require("../__fixtures__/hugging-face-models.json");

const unused = { fetch: jest.fn() };

function source(
  id: string,
  type: "GITHUB" | "HUGGING_FACE",
  identifier: string,
) {
  return { id, type, identifier, config: null } as RadarSource;
}

describe("CollectorRouter native insight adapters", () => {
  afterEach(() => jest.restoreAllMocks());

  it("routes GitHub and Hugging Face through the shared Radar fan-out", async () => {
    // 按 URL 分发，不按调用顺序：fanOut 是并发的，两个 collector 谁先摸到 fetch
    // 取决于各自第一个 await 落在哪（GithubCollector 现在会先 await 取 BYOK token），
    // 用 mockResolvedValueOnce 排队会让 fixture 串门。
    jest.spyOn(global, "fetch").mockImplementation((input) => {
      const url = String(input);
      const body = url.includes("api.github.com")
        ? githubFixture
        : modelFixture;
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    });
    const router = new CollectorRouter(
      unused as never,
      unused as never,
      unused as never,
      unused as never,
      new GithubCollector(),
      new HuggingFaceCollector(),
    );
    const results = await router.fanOut(
      [
        source("github-1", "GITHUB", "trending"),
        source("hf-1", "HUGGING_FACE", "models"),
      ],
      {
        since: new Date("2026-08-01T00:00:00Z"),
        perSourceLimit: 5,
        userId: "user-1",
      },
    );
    expect(results).toEqual([
      expect.objectContaining({
        sourceId: "github-1",
        type: "GITHUB",
        error: null,
        items: [
          expect.objectContaining({
            raw: expect.objectContaining({ provider: "github" }),
          }),
        ],
      }),
      expect.objectContaining({
        sourceId: "hf-1",
        type: "HUGGING_FACE",
        error: null,
        items: [
          expect.objectContaining({
            raw: expect.objectContaining({ provider: "hugging_face" }),
          }),
        ],
      }),
    ]);
  });
});
