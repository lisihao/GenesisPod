import { RadarSource } from "@prisma/client";
import fixture = require("../__fixtures__/github-search.json");
import { GithubCollector } from "../github-collector.service";

function source(identifier = "trending", config: object | null = null) {
  return { identifier, config } as RadarSource;
}

describe("GithubCollector", () => {
  afterEach(() => jest.restoreAllMocks());

  it("maps repository search results into evidence-backed Radar items", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );
    const items = await new GithubCollector().fetch(source(), {
      since: new Date("2026-08-01T00:00:00Z"),
      perSourceLimit: 10,
      userId: "user-1",
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      externalId: "genesispod/native-radar",
      title: "genesispod/native-radar",
      url: "https://github.com/genesispod/native-radar",
      metrics: { stars: 420, forks: 21 },
      raw: {
        provider: "github",
        evidence: {
          externalId: "genesispod/native-radar",
          url: "https://github.com/genesispod/native-radar",
        },
      },
    });
    const requested = String(fetchSpy.mock.calls[0]?.[0]);
    expect(requested).toContain("api.github.com/search/repositories");
    expect(decodeURIComponent(requested)).toContain("pushed:>=2026-08-01");
  });

  it("uses the exact repository endpoint for owner/repo", async () => {
    const repository = fixture.items[0];
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(repository), { status: 200 }),
      );
    const items = await new GithubCollector().fetch(
      source("genesispod/native-radar"),
      {
        since: new Date("2026-08-01T00:00:00Z"),
        perSourceLimit: 1,
        userId: "user-1",
      },
    );
    expect(items).toHaveLength(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/genesispod/native-radar",
    );
  });

  it("surfaces rate-limit failures instead of returning false success", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    );
    await expect(
      new GithubCollector().fetch(source(), {
        since: new Date("2026-08-01T00:00:00Z"),
        perSourceLimit: 1,
        userId: "user-1",
      }),
    ).rejects.toThrow("GitHub API 403 (rate limit exhausted)");
  });
});
