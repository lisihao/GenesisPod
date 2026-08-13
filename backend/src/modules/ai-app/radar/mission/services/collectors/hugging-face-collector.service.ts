import { Injectable, Logger } from "@nestjs/common";
import { RadarSource } from "@prisma/client";
import {
  CollectContext,
  CollectorThrottleError,
  ICollector,
  RawCollectedItem,
} from "./icollector";
import { computeContentHash } from "./hash.util";

type HuggingFaceKind = "models" | "papers";

interface HuggingFaceModel {
  _id?: string;
  id?: string;
  modelId?: string;
  author?: string;
  pipeline_tag?: string;
  library_name?: string;
  tags?: string[];
  downloads?: number;
  likes?: number;
  trendingScore?: number;
  createdAt?: string;
  lastModified?: string;
}

interface HuggingFacePaper {
  id?: string;
  title?: string;
  summary?: string;
  authors?: Array<{ name?: string }>;
  publishedAt?: string;
  upvotes?: number;
  githubRepo?: string;
  githubStars?: number;
  projectPage?: string;
}

interface HuggingFaceDailyPaper {
  title?: string;
  summary?: string;
  publishedAt?: string;
  numComments?: number;
  paper?: HuggingFacePaper;
}

@Injectable()
export class HuggingFaceCollector implements ICollector {
  readonly type = "HUGGING_FACE";
  private readonly log = new Logger(HuggingFaceCollector.name);

  async fetch(
    source: RadarSource,
    ctx: CollectContext,
  ): Promise<RawCollectedItem[]> {
    const { kind, query } = this.parseIdentifier(source.identifier);
    const limit = Math.min(Math.max(ctx.perSourceLimit, 1), 100);
    const url =
      kind === "models"
        ? this.modelsUrl(query, limit)
        : `https://huggingface.co/api/daily_papers?limit=${limit}`;
    const payload = await this.getJson(url);
    if (!Array.isArray(payload)) {
      throw new Error("Hugging Face API returned a non-list payload");
    }
    const filteredPayload =
      kind === "papers" && query
        ? payload.filter((entry) => {
            const paper = entry as HuggingFaceDailyPaper;
            const haystack = `${paper.paper?.title ?? paper.title ?? ""}\n${
              paper.paper?.summary ?? paper.summary ?? ""
            }`.toLowerCase();
            return haystack.includes(query.toLowerCase());
          })
        : payload;
    const items =
      kind === "models"
        ? filteredPayload.map((entry) =>
            this.modelItem(entry as HuggingFaceModel),
          )
        : filteredPayload.map((entry) =>
            this.paperItem(entry as HuggingFaceDailyPaper),
          );
    // 刻意不按 ctx.since 过滤：models 的时间戳是「模型创建时间」（默认响应不返回
    // lastModified），papers 的是「arXiv 首发日」——都不是「本次才出现在榜上」。
    // 用它当增量窗口会把榜单筛空：实测 trending top-20 在定时档（since =
    // lastRunAt-5min）只剩 models 1 条 / papers 0 条，且不报错，源健康度还是绿的。
    // 榜单类源的增量语义交给 S3 的 (topicId, externalId) dedupe——这与 S1 把手动
    // 窗口放宽到 30 天时依赖 dedupe 的理由是同一条。
    const collected = items
      .filter((item): item is RawCollectedItem => item !== null)
      .slice(0, ctx.perSourceLimit);
    this.log.debug(
      `Hugging Face ${kind}:${query} -> ${collected.length} items`,
    );
    return collected;
  }

  private modelsUrl(query: string, limit: number): string {
    const params = new URLSearchParams({
      sort: "trendingScore",
      direction: "-1",
      limit: String(limit),
    });
    if (query) params.set("search", query);
    return `https://huggingface.co/api/models?${params.toString()}`;
  }

  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "GenesisPod-Radar/1.0",
        },
      });
      if (!response.ok) {
        if (response.status === 429) {
          throw new CollectorThrottleError("Hugging Face API 429");
        }
        throw new Error(`Hugging Face API ${response.status}`);
      }
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private modelItem(model: HuggingFaceModel): RawCollectedItem | null {
    const modelId = (model.modelId ?? model.id)?.trim();
    const publishedAt = this.parseDate(model.lastModified ?? model.createdAt);
    if (!modelId || !publishedAt) return null;
    const url = `https://huggingface.co/${modelId}`;
    const content = [
      model.pipeline_tag ? `Pipeline: ${model.pipeline_tag}` : null,
      model.library_name ? `Library: ${model.library_name}` : null,
      model.tags?.length ? `Tags: ${model.tags.slice(0, 20).join(", ")}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n");
    return {
      externalId: `model:${modelId}`,
      contentHash: computeContentHash(modelId, content),
      title: modelId,
      content: content || null,
      author: model.author ?? modelId.split("/")[0] ?? null,
      authorAvatar: null,
      url,
      publishedAt,
      metrics: {
        downloads: model.downloads ?? 0,
        likes: model.likes ?? 0,
        trendingScore: model.trendingScore ?? 0,
      },
      raw: {
        provider: "hugging_face",
        kind: "model",
        evidence: {
          externalId: modelId,
          apiObjectId: model._id ?? null,
          url,
          observedAt: new Date().toISOString(),
        },
        model: model as unknown as Record<string, unknown>,
      },
    };
  }

  private paperItem(entry: HuggingFaceDailyPaper): RawCollectedItem | null {
    const paper = entry.paper ?? {};
    const paperId = paper.id?.trim();
    const title = (paper.title ?? entry.title)?.trim();
    const publishedAt = this.parseDate(paper.publishedAt ?? entry.publishedAt);
    if (!paperId || !title || !publishedAt) return null;
    const url = `https://huggingface.co/papers/${paperId}`;
    const trimmedSummary = (paper.summary ?? entry.summary)?.trim();
    const summary = trimmedSummary?.length ? trimmedSummary : null;
    const authors = paper.authors
      ?.map((author) => author.name?.trim())
      .filter((name): name is string => Boolean(name));
    return {
      externalId: `paper:${paperId}`,
      contentHash: computeContentHash(title, summary),
      title,
      content: summary,
      author: authors?.join(", ") ?? null,
      authorAvatar: null,
      url,
      publishedAt,
      metrics: {
        upvotes: paper.upvotes ?? 0,
        comments: entry.numComments ?? 0,
        githubStars: paper.githubStars ?? 0,
      },
      raw: {
        provider: "hugging_face",
        kind: "paper",
        evidence: {
          externalId: paperId,
          url,
          githubRepo: paper.githubRepo ?? null,
          projectPage: paper.projectPage ?? null,
          observedAt: new Date().toISOString(),
        },
        dailyPaper: entry as unknown as Record<string, unknown>,
      },
    };
  }

  private parseIdentifier(identifier: string): {
    kind: HuggingFaceKind;
    query: string;
  } {
    const trimmed = identifier.trim();
    if (trimmed === "papers") return { kind: "papers", query: "" };
    if (trimmed === "models") return { kind: "models", query: "" };
    if (trimmed.startsWith("papers:")) {
      return { kind: "papers", query: trimmed.slice("papers:".length).trim() };
    }
    if (trimmed.startsWith("models:")) {
      return { kind: "models", query: trimmed.slice("models:".length).trim() };
    }
    return { kind: "models", query: trimmed };
  }

  private parseDate(value?: string): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}
