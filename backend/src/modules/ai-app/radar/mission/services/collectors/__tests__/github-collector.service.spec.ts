import { Test } from "@nestjs/testing";
import { RadarSource } from "@prisma/client";
import { ToolKeyResolverService } from "@/modules/platform/credentials/resolution/tool-key-resolver/tool-key-resolver.service";
import fixture = require("../__fixtures__/github-search.json");
import { GithubCollector } from "../github-collector.service";
import { CollectorThrottleError } from "../icollector";

function source(identifier = "trending", config: object | null = null) {
  return { identifier, config } as RadarSource;
}

describe("GithubCollector", () => {
  afterEach(() => jest.restoreAllMocks());

  // DI 护栏：token 解析器是 @Optional() 注入——装配了要能拿到，没装配也不能让
  // provider 解析失败（boot smoke 覆盖不到单个 provider 的可选注入）。
  it("resolves through Nest DI with and without the token resolver", async () => {
    const withResolver = await Test.createTestingModule({
      providers: [
        GithubCollector,
        {
          provide: ToolKeyResolverService,
          useValue: { resolveToolKey: jest.fn() },
        },
      ],
    }).compile();
    expect(withResolver.get(GithubCollector)).toBeInstanceOf(GithubCollector);

    const withoutResolver = await Test.createTestingModule({
      providers: [GithubCollector],
    }).compile();
    expect(withoutResolver.get(GithubCollector)).toBeInstanceOf(
      GithubCollector,
    );
  });

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

  it("marks quota exhaustion as throttling, not as a broken source", async () => {
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
    ).rejects.toBeInstanceOf(CollectorThrottleError);
  });

  it("keeps a 403 with quota left as a real failure", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 403,
        headers: { "x-ratelimit-remaining": "37" },
      }),
    );
    const error = await new GithubCollector()
      .fetch(source(), {
        since: new Date("2026-08-01T00:00:00Z"),
        perSourceLimit: 1,
        userId: "user-1",
      })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CollectorThrottleError);
  });

  it("sends the resolved BYOK token so the 10 req/min anonymous cap does not apply", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );
    const toolKeys = {
      resolveToolKey: jest.fn().mockResolvedValue({
        value: "ghp_token",
        source: "user",
        secretName: "github-token",
      }),
    };
    await new GithubCollector(toolKeys).fetch(source(), {
      since: new Date("2026-08-01T00:00:00Z"),
      perSourceLimit: 1,
      userId: "user-1",
    });
    expect(toolKeys.resolveToolKey).toHaveBeenCalledWith(
      "github-search",
      "user-1",
    );
    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBe("Bearer ghp_token");
  });

  it("falls back to anonymous access when the token cannot be resolved", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );
    const toolKeys = {
      resolveToolKey: jest.fn().mockRejectedValue(new Error("no key")),
    };
    const items = await new GithubCollector(toolKeys).fetch(source(), {
      since: new Date("2026-08-01T00:00:00Z"),
      perSourceLimit: 1,
      userId: "user-1",
    });
    expect(items).toHaveLength(1);
    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });
});

/**
 * 配额保护（2026-08-13 复核意见）
 *
 * 之前只做到「撞上 403 之后把它分类成 throttle」——请求照发、照计进 GitHub 的账。
 * 匿名 search 配额 10 次/分钟，一个 cron tick 上几个 GITHUB 源足以打穿。
 * 现在：响应头写进程内账本 + 请求串行 + 发车前查账，余量为 0 直接本地短路。
 */
describe("GithubCollector 配额保护", () => {
  afterEach(() => jest.restoreAllMocks());

  const ctx = {
    since: new Date("2026-08-01T00:00:00Z"),
    perSourceLimit: 1,
    userId: "user-1",
  };

  function exhaustedResponse() {
    return new Response("{}", {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
      },
    });
  }

  it("配额耗尽后，后续请求在本地短路——不再发出任何网络调用", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(exhaustedResponse());
    const collector = new GithubCollector();

    // 第一次：真的发车，撞墙，学到余量=0
    await expect(collector.fetch(source(), ctx)).rejects.toBeInstanceOf(
      CollectorThrottleError,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 第二、三次：账本说没余量 → 直接 throttle，fetch 调用数不再增长
    await expect(collector.fetch(source(), ctx)).rejects.toBeInstanceOf(
      CollectorThrottleError,
    );
    await expect(collector.fetch(source(), ctx)).rejects.toBeInstanceOf(
      CollectorThrottleError,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("429 缺少配额响应头时按本地兜底窗口冷却，不会继续撞上游", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("{}", { status: 429 }));
    const collector = new GithubCollector();

    await expect(collector.fetch(source(), ctx)).rejects.toBeInstanceOf(
      CollectorThrottleError,
    );
    const second = await collector
      .fetch(source(), ctx)
      .catch((error: unknown) => error as Error);

    expect(second).toBeInstanceOf(CollectorThrottleError);
    expect(second.message).toContain("本次未发起请求");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("匿名 search 配额耗尽不会阻断拥有独立 Token 的用户", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 60);
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response("{}", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": reset,
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), {
          status: 200,
          headers: {
            "x-ratelimit-remaining": "29",
            "x-ratelimit-reset": reset,
          },
        }),
      );
    const toolKeys = {
      resolveToolKey: jest.fn(async (_toolId: string, userId: string) =>
        userId === "token-user"
          ? {
              value: "ghp_independent_token",
              source: "user",
              secretName: "github-token",
            }
          : null,
      ),
    };
    const collector = new GithubCollector(toolKeys);

    await expect(
      collector.fetch(source(), { ...ctx, userId: "anonymous-user" }),
    ).rejects.toBeInstanceOf(CollectorThrottleError);
    const items = await collector.fetch(source(), {
      ...ctx,
      userId: "token-user",
    });

    expect(items).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const tokenHeaders = (fetchSpy.mock.calls[1]?.[1] as RequestInit)
      .headers as Record<string, string>;
    expect(tokenHeaders.Authorization).toBe("Bearer ghp_independent_token");
  });

  it("短路错误说明「未发起请求」+ 多久恢复，不冒充上游响应", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(exhaustedResponse());
    const collector = new GithubCollector();
    await collector.fetch(source(), ctx).catch(() => undefined);

    const err = await collector
      .fetch(source(), ctx)
      .catch((e: unknown) => e as Error);
    expect(err.message).toContain("未发起请求");
    expect(err.message).toMatch(/\d+s 后重置/);
  });

  it("并发的多个源被串行化——不会同时读到过期账本一起发车", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(exhaustedResponse());
    const collector = new GithubCollector();

    // 模拟 CollectorRouter.fanOut 的并发调用
    const results = await Promise.allSettled([
      collector.fetch(source("a"), ctx),
      collector.fetch(source("b"), ctx),
      collector.fetch(source("c"), ctx),
      collector.fetch(source("d"), ctx),
    ]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    // 只有第一个真的打了 GitHub，其余三个零网络开销
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("重置时间已过 → 账本作废，重新放行", async () => {
    const staleReset = new Response("{}", {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        // 已经过去的重置时间
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) - 1),
      },
    });
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(staleReset)
      .mockResolvedValue(
        new Response(JSON.stringify(fixture), {
          status: 200,
          headers: { "x-ratelimit-remaining": "9" },
        }),
      );
    const collector = new GithubCollector();

    await collector.fetch(source(), ctx).catch(() => undefined);
    const items = await collector.fetch(source(), ctx);

    expect(items).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("成功响应也刷新账本：余量充足时不影响后续请求", async () => {
    // 每次都造新 Response —— body 只能消费一次，复用同一个实例第二次会炸
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(fixture), {
          status: 200,
          headers: {
            "x-ratelimit-remaining": "7",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
          },
        }),
      ),
    );
    const collector = new GithubCollector();
    await collector.fetch(source(), ctx);
    await collector.fetch(source(), ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("search 与 core 是两个独立池子，互不误伤", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      // 第一次：search 配额打穿
      .mockResolvedValueOnce(exhaustedResponse())
      // 第二次：exact repo 走 core，仍应放行
      .mockResolvedValue(
        new Response(JSON.stringify(fixture.items[0]), {
          status: 200,
          headers: { "x-ratelimit-remaining": "59" },
        }),
      );
    const collector = new GithubCollector();

    await collector.fetch(source("trending"), ctx).catch(() => undefined);
    const items = await collector.fetch(source("genesispod/native-radar"), ctx);

    expect(items).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
