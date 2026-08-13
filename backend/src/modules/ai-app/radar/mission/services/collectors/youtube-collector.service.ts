import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { RadarSource } from "@prisma/client";
import { ContentFetchService } from "@/modules/ai-engine/facade";
// CJS 互操作：rss-parser `module.exports = Parser`（无 default），TS `import Parser from`
// 在 CJS target 编译成 `rss_parser_1.default()`，prod 立即 `not a constructor` 崩溃。
// 用 namespace import 拿运行时对象 + type-only import 拿泛型签名。
import type ParserType from "rss-parser";
import * as RssParserModule from "rss-parser";
import { CollectContext, ICollector, RawCollectedItem } from "./icollector";
import { computeContentHash } from "./hash.util";
import { assertSafeHttpUrl } from "./ssrf-util";

interface YouTubeRssItem {
  id?: string;
  link?: string;
  title?: string;
  author?: string;
  isoDate?: string;
  pubDate?: string;
  /** rss-parser 解析后的 enclosure 等字段 */
  "media:group"?: {
    "media:description"?: string[];
    "media:thumbnail"?: Array<{ $: { url: string } }>;
    "media:community"?: Array<{
      "media:statistics"?: Array<{ $: { views: string } }>;
      "media:starRating"?: Array<{ $: { count: string; average: string } }>;
    }>;
  };
  "yt:videoId"?: string;
  "yt:channelId"?: string;
  [k: string]: unknown;
}

const VIDEO_ID_RE = /[A-Za-z0-9_-]{11}/;
const CHANNEL_ID_RE = /UC[A-Za-z0-9_-]{22}/;

type ParserCtor = new (
  ...args: ConstructorParameters<typeof ParserType>
) => ParserType<unknown, YouTubeRssItem>;
const ParserCtor: ParserCtor = ((
  RssParserModule as unknown as { default?: unknown }
).default ?? RssParserModule) as ParserCtor;

/**
 * YouTubeCollector —— 通过 YouTube channel RSS feed 拉最新视频。
 *
 *   https://www.youtube.com/feeds/videos.xml?channel_id={CHANNEL_ID}
 *
 * 兜底策略（PR-R2 仅启用 RSS 路径）：
 * - 用户配 YT Data API key (Secret SOCIAL_YOUTUBE) → PR-R4 接入 channel.search?order=date
 * - 字幕：默认开启，`source.config.fetchTranscript === false` 才关。
 *   （原先默认关，而只有前端「单条添加」表单会写 fetchTranscript:true——批量导入
 *   和 discovery 入库的号一律没有 config，大咖洞察实际跑在「无字幕」状态。
 *   开销可控：只对通过 since 窗口的新视频取，且 YouTubeTranscriptCache 兜底。）
 *
 * identifier 接受：
 * - 24 位 channelId (UC...)
 * - https://www.youtube.com/channel/UC... URL
 * - https://www.youtube.com/@handle URL（HTML scrape 解析 channelId，
 *   cache 到 source.config.resolvedChannelId 避免每次重复抓页）
 */
@Injectable()
export class YoutubeCollector implements ICollector {
  readonly type = "YOUTUBE";
  private readonly log = new Logger(YoutubeCollector.name);
  private readonly parser: ParserType<unknown, YouTubeRssItem>;

  constructor(
    @Optional()
    @Inject(ContentFetchService)
    private readonly contentFetch?: Pick<
      ContentFetchService,
      "fetchFromYoutubeUrl"
    >,
  ) {
    this.parser = new ParserCtor({
      timeout: 25_000,
      requestOptions: {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; GenesisRadar/1.0; +https://gens.team/bot)",
        },
      },
      customFields: {
        // tuple [xmlTag, fieldName] form 兼容 rss-parser 严格类型
        item: [
          ["yt:videoId", "yt:videoId"],
          ["yt:channelId", "yt:channelId"],
          ["media:group", "media:group"],
        ],
      },
    });
  }

  async fetch(
    source: RadarSource,
    ctx: CollectContext,
  ): Promise<RawCollectedItem[]> {
    // 1) 优先用 source.config.resolvedChannelId 缓存（首次 resolve 之后避免每次抓 HTML）
    const cached = this.getCachedChannelId(source);
    // 2) 试 identifier 内的 channelId / channel-URL 正则
    // 3) 兜底 fetch @handle URL HTML 抓 channelId（仅 @handle 需要）
    const channelId =
      cached ??
      this.extractChannelId(source.identifier) ??
      (await this.resolveChannelIdFromHandle(source.identifier));
    if (!channelId) {
      throw new Error(
        `无法从 identifier 提取 channelId: ${source.identifier}（试过 UC.../channel/URL/@handle 三种格式）`,
      );
    }
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    assertSafeHttpUrl(feedUrl);
    const feed = await this.parser.parseURL(feedUrl);
    const out: RawCollectedItem[] = [];
    for (const item of feed.items ?? []) {
      if (out.length >= ctx.perSourceLimit) break;
      const publishedAt = this.parseDate(item.isoDate ?? item.pubDate);
      if (!publishedAt) continue;
      if (publishedAt <= ctx.since) continue;
      const videoId = this.extractVideoId(item);
      if (!videoId) continue;
      const title = (item.title ?? "").trim() || null;
      const description = this.extractDescription(item);
      const metrics = this.extractMetrics(item);
      const thumbnail = this.extractThumbnail(item);
      const videoUrl =
        item.link ?? `https://www.youtube.com/watch?v=${videoId}`;
      const transcript = await this.fetchTranscriptEvidence(
        source,
        videoId,
        videoUrl,
      );
      const content = transcript.accepted ? transcript.content : description;
      out.push({
        externalId: videoId,
        contentHash: computeContentHash(title, content),
        title,
        content,
        author: item.author ?? null,
        authorAvatar: null,
        url: videoUrl,
        publishedAt,
        metrics,
        raw: {
          videoId,
          thumbnail,
          channelId: item["yt:channelId"] ?? channelId,
          evidence: {
            provider: "youtube",
            externalId: videoId,
            url: videoUrl,
            observedAt: new Date().toISOString(),
            transcript: transcript.evidence,
          },
        },
      });
    }
    this.log.debug(`YT channel=${channelId} → ${out.length} new videos`);
    return out;
  }

  private async fetchTranscriptEvidence(
    source: RadarSource,
    videoId: string,
    videoUrl: string,
  ): Promise<{
    accepted: boolean;
    content: string | null;
    evidence: TranscriptEvidence;
  }> {
    const config = this.readConfig(source.config);
    if (!config.fetchTranscript) {
      return {
        accepted: false,
        content: null,
        evidence: { status: "not_requested", reason: "fetchTranscript=false" },
      };
    }
    if (!this.contentFetch) {
      return {
        accepted: false,
        content: null,
        evidence: {
          status: "unavailable",
          reason: "ContentFetchService not available",
        },
      };
    }
    try {
      const fetched = await this.contentFetch.fetchFromYoutubeUrl(
        videoId,
        videoUrl,
      );
      const quality = assessTranscriptQuality(
        fetched.content,
        config.transcriptMinChars,
      );
      return {
        accepted: quality.accepted,
        content: quality.accepted ? fetched.content : null,
        evidence: {
          status: quality.accepted ? "accepted" : "rejected",
          reason: quality.reason,
          charCount: quality.charCount,
          wordCount: quality.wordCount,
          fetchedAt: String(
            fetched.metadata?.fetchedAt ?? new Date().toISOString(),
          ),
          isBilingual: fetched.isBilingual ?? false,
        },
      };
    } catch (error) {
      const reason = (error as Error).message || String(error);
      this.log.warn(`YT transcript unavailable video=${videoId}: ${reason}`);
      return {
        accepted: false,
        content: null,
        evidence: { status: "unavailable", reason },
      };
    }
  }

  private readConfig(value: unknown): {
    fetchTranscript: boolean;
    transcriptMinChars: number;
  } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { fetchTranscript: true, transcriptMinChars: 200 };
    }
    const config = value as Record<string, unknown>;
    const rawMin = config.transcriptMinChars;
    return {
      fetchTranscript: config.fetchTranscript !== false,
      transcriptMinChars:
        typeof rawMin === "number" && Number.isFinite(rawMin)
          ? Math.min(10_000, Math.max(100, Math.floor(rawMin)))
          : 200,
    };
  }

  private extractChannelId(identifier: string): string | null {
    const trimmed = identifier.trim();
    if (CHANNEL_ID_RE.test(trimmed) && trimmed.length === 24) return trimmed;
    const match = trimmed.match(/channel\/(UC[A-Za-z0-9_-]{22})/);
    if (match) return match[1];
    return null;
  }

  /**
   * source.config.resolvedChannelId 缓存（首次 @handle 解析后写入，
   * 后续 fetch 直接命中，避免每次刷新都抓 HTML）。
   *
   * 注意：当前未在解析成功后回写 source.config —— Prisma 写库需要 PrismaService
   * 注入，YouTubeCollector 故意不直接依赖。若性能确成瓶颈，由 collector-router
   * 在 collect 完成后回写（与 health/cooldown 同链路）。当前每次 fetch
   * 重新抓 HTML（200ms），单源每 6h 一次 cron，开销可接受。
   */
  private getCachedChannelId(source: RadarSource): string | null {
    const cfg = source.config;
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
    const cached = (cfg as Record<string, unknown>)["resolvedChannelId"];
    if (typeof cached === "string" && CHANNEL_ID_RE.test(cached)) return cached;
    return null;
  }

  /**
   * 抓 `https://www.youtube.com/@handle` HTML 解析 channelId。YouTube 在
   * channel 页面 inline JSON 里多处嵌 `"externalId":"UC..."` / `<link
   * rel="canonical" href=".../channel/UC...">` / `<meta itemprop="identifier"
   * content="UC...">`。任意一处命中即可。
   *
   * 返回 null 时调用方 throw —— 不是所有 @handle 都对应真实 channel，
   * LLM 可能 hallucinate handle，必须有挡。
   */
  private async resolveChannelIdFromHandle(
    identifier: string,
  ): Promise<string | null> {
    const url = this.normalizeHandleUrl(identifier);
    if (!url) return null;
    assertSafeHttpUrl(url);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; gens.team-Radar/1.0; +https://gens.team)",
          Accept: "text/html",
        },
        redirect: "follow",
      });
      clearTimeout(timeout);
      if (!res.ok) {
        this.log.warn(`YT handle resolve failed: ${url} status=${res.status}`);
        return null;
      }
      const html = await res.text();
      // 三种常见嵌入位置，按命中可能性从高到低
      const externalId = html.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/);
      if (externalId) return externalId[1];
      const canonical = html.match(
        /<link[^>]+rel="canonical"[^>]+href="[^"]*\/channel\/(UC[A-Za-z0-9_-]{22})/,
      );
      if (canonical) return canonical[1];
      const itemprop = html.match(
        /<meta[^>]+itemprop="identifier"[^>]+content="(UC[A-Za-z0-9_-]{22})"/,
      );
      if (itemprop) return itemprop[1];
      this.log.warn(`YT handle resolve no channelId in HTML: ${url}`);
      return null;
    } catch (err) {
      this.log.warn(
        `YT handle resolve threw: ${url} ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** 规范化 @handle / URL → `https://www.youtube.com/@handle` */
  private normalizeHandleUrl(identifier: string): string | null {
    const trimmed = identifier.trim();
    if (trimmed.startsWith("@")) {
      return `https://www.youtube.com/${trimmed}`;
    }
    if (/^https?:\/\/(www\.|m\.)?youtube\.com\/@/.test(trimmed)) {
      return trimmed;
    }
    return null;
  }

  private extractVideoId(item: YouTubeRssItem): string | null {
    if (item["yt:videoId"] && typeof item["yt:videoId"] === "string") {
      return item["yt:videoId"];
    }
    if (item.id && typeof item.id === "string") {
      const m = item.id.match(VIDEO_ID_RE);
      if (m) return m[0];
    }
    if (item.link) {
      const m = item.link.match(/[?&]v=([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
    return null;
  }

  private extractDescription(item: YouTubeRssItem): string | null {
    const group = item["media:group"];
    const desc = group?.["media:description"]?.[0];
    if (typeof desc === "string") return desc.trim() || null;
    return null;
  }

  private extractMetrics(
    item: YouTubeRssItem,
  ): Record<string, number | string> | null {
    const community = item["media:group"]?.["media:community"]?.[0];
    if (!community) return null;
    const metrics: Record<string, number | string> = {};
    const stats = community["media:statistics"]?.[0];
    if (stats?.$.views) metrics.views = Number(stats.$.views);
    const rating = community["media:starRating"]?.[0];
    if (rating?.$.count) metrics.ratings = Number(rating.$.count);
    if (rating?.$.average) metrics.starAverage = rating.$.average;
    return Object.keys(metrics).length > 0 ? metrics : null;
  }

  private extractThumbnail(item: YouTubeRssItem): string | null {
    const arr = item["media:group"]?.["media:thumbnail"];
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr[0]?.$?.url ?? null;
  }

  private parseDate(s?: string | null): Date | null {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
}

export interface TranscriptEvidence {
  status: "not_requested" | "accepted" | "rejected" | "unavailable";
  reason: string;
  charCount?: number;
  wordCount?: number;
  fetchedAt?: string;
  isBilingual?: boolean;
}

export function assessTranscriptQuality(
  content: string | null | undefined,
  minChars = 200,
): {
  accepted: boolean;
  reason: string;
  charCount: number;
  wordCount: number;
} {
  const normalized = (content ?? "").replace(/\s+/g, " ").trim();
  const wordCount = normalized ? normalized.split(/\s+/).length : 0;
  const charCount = normalized.length;
  if (!normalized) {
    return {
      accepted: false,
      reason: "empty_transcript",
      charCount,
      wordCount,
    };
  }
  if (
    /(?:transcript (?:is )?unavailable|subtitles? (?:are )?disabled|sign in to confirm)/i.test(
      normalized,
    )
  ) {
    return {
      accepted: false,
      reason: "provider_error_text",
      charCount,
      wordCount,
    };
  }
  if (charCount < minChars) {
    return {
      accepted: false,
      reason: `too_short:${charCount}<${minChars}`,
      charCount,
      wordCount,
    };
  }
  return {
    accepted: true,
    reason: "quality_gate_passed",
    charCount,
    wordCount,
  };
}
