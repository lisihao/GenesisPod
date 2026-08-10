import { Injectable, Logger } from "@nestjs/common";
import { RadarSource } from "@prisma/client";
import { CollectContext, ICollector, RawCollectedItem } from "./icollector";
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

/**
 * Native GitHub Radar adapter.
 *
 * identifier:
 * - `trending`: active repositories, optionally constrained by config
 * - `owner/repo`: one exact public repository
 * - any other string: a GitHub repository search query
 */
@Injectable()
export class GithubCollector implements ICollector {
  readonly type = "GITHUB";
  private readonly log = new Logger(GithubCollector.name);

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
    const payload = await this.getJson(url);
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

  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": USER_AGENT,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        const suffix = remaining === "0" ? " (rate limit exhausted)" : "";
        throw new Error(`GitHub API ${response.status}${suffix}`);
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
