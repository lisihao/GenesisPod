import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { RadarSource } from "@prisma/client";
import { ToolKeyResolverService } from "@/modules/platform/credentials/resolution/tool-key-resolver/tool-key-resolver.service";
import {
  CollectContext,
  CollectorThrottleError,
  ICollector,
  RawCollectedItem,
} from "./icollector";
import { computeContentHash } from "./hash.util";

interface GithubOwner {
  login?: string;
  avatar_url?: string;
}

interface GithubRepository {
  id?: number;
  node_id?: string;
  full_name?: string;
  html_url?: string;
  description?: string | null;
  owner?: GithubOwner;
  language?: string | null;
  topics?: string[];
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  watchers_count?: number;
  created_at?: string;
  updated_at?: string;
  pushed_at?: string;
}

interface GithubSearchResponse {
  total_count?: number;
  incomplete_results?: boolean;
  items?: GithubRepository[];
}

interface GithubCollectorConfig {
  language?: string;
  minStars?: number;
  sort?: "stars" | "updated";
}

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const USER_AGENT = "GenesisPod-Radar/1.0";
/** EXTERNAL_TOOL_SECRET_MAPPING 里已有的 tool id（→ secret `github-token`） */
const GITHUB_TOOL_ID = "github-search";

/**
 * Native GitHub Radar adapter.
 *
 * identifier:
 * - `trending`: active repositories, optionally constrained by config
 * - `owner/repo`: one exact public repository
 * - any other string: a GitHub repository search query
 */
/** GitHub 按 resource 分配额（search 与 core 是两个独立池子） */
type GithubQuotaResource = "search" | "core";
type GithubQuotaKey = string;

interface GithubQuotaState {
  /** 上一次响应头里的 x-ratelimit-remaining */
  remaining: number;
  /** x-ratelimit-reset（epoch 秒）换算的毫秒时间戳 */
  resetAtMs: number;
}

@Injectable()
export class GithubCollector implements ICollector {
  readonly type = "GITHUB";
  private readonly log = new Logger(GithubCollector.name);

  /**
   * 进程内配额账本（resource + 凭据身份 → 上次响应头告诉我们的余量）。
   *
   * 这是「撞之前就别撞」的那一半：光把 403 分类成 throttle 只是事后补救，
   * 请求照样发出去、照样计进 GitHub 的账。匿名 search 配额 10 次/分钟，
   * 一个 cron tick 上几个 GITHUB 源足以打穿。
   */
  private readonly quota = new Map<GithubQuotaKey, GithubQuotaState>();

  /**
   * 串行闸：同一进程内 GitHub 请求排队执行，不并发。
   *
   * 没有它，N 个源会在同一时刻读到同一份「还有余量」的旧账本然后一起发车，
   * 配额账本永远慢一拍。串行后第一个请求就能把余量写回，后续直接短路。
   * 代价：GitHub 源采集从并行变串行——单请求 ~300ms，可接受。
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    @Optional()
    @Inject(ToolKeyResolverService)
    private readonly toolKeys?: Pick<ToolKeyResolverService, "resolveToolKey">,
  ) {}

  async fetch(
    source: RadarSource,
    ctx: CollectContext,
  ): Promise<RawCollectedItem[]> {
    const config = this.readConfig(source.config);
    const identifier = source.identifier.trim();
    const exactRepository = OWNER_REPO_RE.test(identifier);
    const url = exactRepository
      ? `https://api.github.com/repos/${identifier}`
      : this.buildSearchUrl(identifier, config, ctx);
    const resource: GithubQuotaResource = exactRepository ? "core" : "search";
    const payload = await this.runExclusive(async () => {
      const token = await this.resolveToken(ctx.userId);
      const quotaKey = this.createQuotaKey(resource, token);
      this.assertQuotaAvailable(quotaKey, resource);
      return this.getJson(url, token, resource, quotaKey);
    });
    const repositories = exactRepository
      ? [payload as GithubRepository]
      : ((payload as GithubSearchResponse).items ?? []);

    const items = repositories
      .map((repo) => this.toCollectedItem(repo))
      .filter((item): item is RawCollectedItem => item !== null)
      .filter((item) => item.publishedAt > ctx.since)
      .slice(0, ctx.perSourceLimit);

    this.log.debug(`GitHub ${identifier} -> ${items.length} repositories`);
    return items;
  }

  private buildSearchUrl(
    identifier: string,
    config: GithubCollectorConfig,
    ctx: CollectContext,
  ): string {
    const queryParts: string[] = [];
    if (identifier !== "trending") queryParts.push(identifier);
    if (config.language) queryParts.push(`language:${config.language}`);
    queryParts.push(`stars:>=${config.minStars ?? 100}`);
    queryParts.push(`pushed:>=${ctx.since.toISOString().slice(0, 10)}`);
    const params = new URLSearchParams({
      q: queryParts.join(" "),
      sort: config.sort ?? "stars",
      order: "desc",
      per_page: String(Math.min(Math.max(ctx.perSourceLimit, 1), 100)),
    });
    return `https://api.github.com/search/repositories?${params.toString()}`;
  }

  /**
   * 可选 GitHub token（BYOK：用户 Key → 授权 → admin fallback）。
   *
   * 匿名也能跑，但 Search API 配额只有 10 次/分钟/IP；带 token 时 core
   * 通常为 5000 次/小时，search 使用独立配额桶，实际值以响应头为准。
   * 解析失败（未配置 / STRICT 无 Key / credentials 抖动）一律降级为匿名，
   * 不能让取 Key 这一步把整个采集拖挂。
   */
  private async resolveToken(userId: string): Promise<string | null> {
    if (!this.toolKeys || !userId) return null;
    try {
      const resolved = await this.toolKeys.resolveToolKey(
        GITHUB_TOOL_ID,
        userId,
      );
      return resolved?.value ?? null;
    } catch (err) {
      this.log.debug(
        `GitHub token 未解析到，降级匿名调用: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** 让所有 GitHub 请求排一条队，避免并发源同时读到过期的配额账本 */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task, task);
    // 无论成败都让队列继续，且不产生 unhandled rejection
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 不把 Token 明文留在进程内 Map key 中，只保留稳定的短摘要。 */
  private createQuotaKey(
    resource: GithubQuotaResource,
    token: string | null,
  ): GithubQuotaKey {
    const credential = token
      ? `token:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`
      : "anonymous";
    return `${resource}:${credential}`;
  }

  /**
   * 发请求**之前**查账本：已知配额为 0 且未到重置时间 → 直接 throttle，不发车。
   *
   * 这样一轮 mission 里只有第一个源真的撞墙，其余零网络开销地降级，
   * 也不会把 GitHub 的 secondary rate limit（滥用检测）惹出来。
   */
  private assertQuotaAvailable(
    quotaKey: GithubQuotaKey,
    resource: GithubQuotaResource,
  ): void {
    const state = this.quota.get(quotaKey);
    if (!state) return;
    const now = Date.now();
    if (now >= state.resetAtMs) {
      // 窗口已过，账本失效，放行让真实响应重新填
      this.quota.delete(quotaKey);
      return;
    }
    if (state.remaining > 0) return;
    const waitSec = Math.max(1, Math.ceil((state.resetAtMs - now) / 1000));
    throw new CollectorThrottleError(
      `GitHub ${resource} 配额已耗尽，${waitSec}s 后重置（本次未发起请求）`,
    );
  }

  /** 用响应头刷新账本；429 即使缺头也会进入本地兜底冷却。 */
  private recordQuota(
    quotaKey: GithubQuotaKey,
    resource: GithubQuotaResource,
    headers: Headers,
    status: number,
  ): void {
    const headerRemaining = this.readNumericHeader(
      headers,
      "x-ratelimit-remaining",
    );
    const remaining = status === 429 ? 0 : headerRemaining;
    if (remaining === null) return;
    const resetAtMs = this.resolveResetAt(headers);
    this.quota.set(quotaKey, { remaining, resetAtMs });
    if (remaining <= 0) {
      this.log.warn(
        `GitHub ${resource} 配额耗尽，后续请求将在本地短路直到 ${new Date(resetAtMs).toISOString()}`,
      );
    }
  }

  private readNumericHeader(headers: Headers, name: string): number | null {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  private resolveResetAt(headers: Headers): number {
    const resetSec = this.readNumericHeader(headers, "x-ratelimit-reset");
    if (resetSec !== null && resetSec > 0) return resetSec * 1000;

    const retryAfter = headers.get("retry-after")?.trim();
    if (retryAfter) {
      const delaySec = Number(retryAfter);
      if (Number.isFinite(delaySec) && delaySec >= 0) {
        return Date.now() + delaySec * 1000;
      }
      const retryAtMs = Date.parse(retryAfter);
      if (Number.isFinite(retryAtMs) && retryAtMs > Date.now()) {
        return retryAtMs;
      }
    }

    // GitHub 最短常规窗口为 search 的 1 分钟；缺头时保守冷却同样时长。
    return Date.now() + 60_000;
  }

  private async getJson(
    url: string,
    token: string | null,
    resource: GithubQuotaResource,
    quotaKey: GithubQuotaKey,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": USER_AGENT,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      this.recordQuota(quotaKey, resource, response.headers, response.status);
      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        // GitHub 配额耗尽返回 403（不是 429），得靠 x-ratelimit-remaining 才能
        // 与「仓库私有/被封」这类真故障区分开。
        const rateLimited =
          response.status === 429 ||
          (response.status === 403 && remaining === "0");
        if (rateLimited) {
          throw new CollectorThrottleError(
            `GitHub API ${response.status} (rate limit exhausted)`,
          );
        }
        throw new Error(`GitHub API ${response.status}`);
      }
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private toCollectedItem(repo: GithubRepository): RawCollectedItem | null {
    const fullName = repo.full_name?.trim();
    const url = repo.html_url?.trim();
    const publishedAt = this.parseDate(
      repo.pushed_at ?? repo.updated_at ?? repo.created_at,
    );
    if (!fullName || !url || !publishedAt) return null;
    const trimmedDescription = repo.description?.trim();
    const description = trimmedDescription?.length ? trimmedDescription : null;
    const content = [
      description,
      repo.language ? `Language: ${repo.language}` : null,
      repo.topics?.length ? `Topics: ${repo.topics.join(", ")}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n");
    return {
      externalId: fullName,
      contentHash: computeContentHash(fullName, content),
      title: fullName,
      content: content || null,
      author: repo.owner?.login ?? null,
      authorAvatar: repo.owner?.avatar_url ?? null,
      url,
      publishedAt,
      metrics: {
        stars: repo.stargazers_count ?? 0,
        forks: repo.forks_count ?? 0,
        openIssues: repo.open_issues_count ?? 0,
        watchers: repo.watchers_count ?? 0,
      },
      raw: {
        provider: "github",
        evidence: {
          externalId: fullName,
          apiObjectId: repo.node_id ?? repo.id ?? null,
          url,
          observedAt: new Date().toISOString(),
        },
        repository: repo as unknown as Record<string, unknown>,
      },
    };
  }

  private readConfig(value: unknown): GithubCollectorConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const input = value as Record<string, unknown>;
    const language =
      typeof input.language === "string" && input.language.trim()
        ? input.language.trim()
        : undefined;
    const minStars =
      typeof input.minStars === "number" && Number.isFinite(input.minStars)
        ? Math.max(0, Math.floor(input.minStars))
        : undefined;
    const sort =
      input.sort === "updated" || input.sort === "stars"
        ? input.sort
        : undefined;
    return { language, minStars, sort };
  }

  private parseDate(value?: string): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}
