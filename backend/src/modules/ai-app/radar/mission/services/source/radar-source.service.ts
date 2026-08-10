import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, RadarSource, RadarSourceType } from "@prisma/client";
import { PrismaService } from "../../../../../../common/prisma/prisma.service";
import {
  CreatableRadarSourceTypeDto,
  CreateRadarSourceDto,
  UpdateRadarSourceDto,
} from "../../../api/dto";
import { RadarTopicService } from "../topic/radar-topic.service";
import { assertSafeHttpUrl } from "../collectors/ssrf-util";
import { CollectorRouter } from "../collectors/collector-router.service";
import { isPublicSource } from "./is-public-source.util";

@Injectable()
export class RadarSourceService {
  private readonly log = new Logger(RadarSourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly topics: RadarTopicService,
    private readonly collectorRouter: CollectorRouter,
  ) {}

  async create(
    userId: string,
    topicId: string,
    dto: CreateRadarSourceDto,
  ): Promise<RadarSource> {
    await this.topics.getOwnedById(userId, topicId);
    const identifier = dto.identifier.trim();
    if (!identifier) throw new BadRequestException("identifier 不能为空");

    const type = dto.type as unknown as RadarSourceType;
    this.assertIdentifierShape(type, identifier);

    try {
      return await this.prisma.radarSource.create({
        data: {
          topicId,
          type,
          identifier,
          label: dto.label?.trim() ?? null,
          config:
            dto.config === undefined
              ? Prisma.JsonNull
              : (dto.config as Prisma.InputJsonValue),
          enabled: dto.enabled ?? true,
          // undefined 时交给 Prisma `@default(3)`，不在此处重复写死默认值
          authorityWeight: dto.authorityWeight,
          isAiRecommended: false,
          isPublicSource: isPublicSource({
            type,
            identifier,
            config: dto.config ?? null,
          }),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "同 topic 下已有相同 type+identifier 的数据源",
        );
      }
      throw error;
    }
  }

  async listByTopic(userId: string, topicId: string): Promise<RadarSource[]> {
    await this.topics.getOwnedById(userId, topicId);
    return this.prisma.radarSource.findMany({
      where: { topicId },
      orderBy: [{ enabled: "desc" }, { createdAt: "asc" }],
    });
  }

  async getOwnedById(userId: string, sourceId: string): Promise<RadarSource> {
    const source = await this.prisma.radarSource.findUnique({
      where: { id: sourceId },
      include: { topic: true },
    });
    if (!source) throw new NotFoundException("Radar source not found");
    if (source.topic.userId !== userId) {
      throw new ForbiddenException("Not owner");
    }
    return source;
  }

  async update(
    userId: string,
    sourceId: string,
    dto: UpdateRadarSourceDto,
  ): Promise<RadarSource> {
    await this.getOwnedById(userId, sourceId);
    const data: Prisma.RadarSourceUpdateInput = {};
    if (dto.label !== undefined) data.label = dto.label?.trim() ?? null;
    if (dto.config !== undefined) {
      data.config =
        dto.config === null
          ? Prisma.JsonNull
          : (dto.config as Prisma.InputJsonValue);
    }
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.authorityWeight !== undefined) {
      data.authorityWeight = dto.authorityWeight;
    }
    return this.prisma.radarSource.update({ where: { id: sourceId }, data });
  }

  async delete(userId: string, sourceId: string): Promise<void> {
    await this.getOwnedById(userId, sourceId);
    await this.prisma.radarSource.delete({ where: { id: sourceId } });
  }

  /**
   * Preflight 探测候选源可达性 —— shape 校验 + CollectorRouter.fanOut 真发请求。
   *
   * R7 2026-05-19：从 bulkCreate（原 bulkCreateAiRecommended）抽出来变 public，让 discovery
   * 推荐阶段也能用（推荐时就 preflight，前端只展示可达候选，不再"接受才发现 5/6 失败"）。
   *
   * - 不写库：纯探测，结果返回 {live, skipped} 由调用方决定怎么用
   * - 复用现有 CollectorRouter.fanOut（不造轮子），since=未来让 collector 拉
   *   空数组但仍发网络请求 → 真探测可达性
   * - 单源失败不阻塞（fan-out 并发）
   */
  async preflightCandidates(
    topicId: string,
    userId: string,
    candidates: Array<{
      type: CreatableRadarSourceTypeDto;
      identifier: string;
      label?: string;
      config?: Record<string, unknown>;
      authorityWeight?: number;
      enabled?: boolean;
    }>,
  ): Promise<{
    live: Array<{
      type: RadarSourceType;
      identifier: string;
      label?: string;
      config?: Record<string, unknown>;
      authorityWeight?: number;
      enabled?: boolean;
    }>;
    skipped: Array<{ type: string; identifier: string; reason: string }>;
  }> {
    // 1) shape 校验
    const shapeOk: Array<{
      type: RadarSourceType;
      identifier: string;
      label?: string;
      config?: Record<string, unknown>;
      authorityWeight?: number;
      enabled?: boolean;
    }> = [];
    const skipped: Array<{ type: string; identifier: string; reason: string }> =
      [];
    for (const c of candidates) {
      const identifier = c.identifier.trim();
      if (!identifier) {
        skipped.push({
          type: c.type,
          identifier: c.identifier,
          reason: "空 identifier",
        });
        continue;
      }
      const type = c.type as unknown as RadarSourceType;
      try {
        this.assertIdentifierShape(type, identifier);
        shapeOk.push({
          type,
          identifier,
          label: c.label,
          config: c.config,
          authorityWeight: c.authorityWeight,
          enabled: c.enabled,
        });
      } catch (err) {
        this.log.warn(
          `Preflight shape-invalid ${type}:${identifier} - ${(err as Error).message}`,
        );
        skipped.push({ type, identifier, reason: (err as Error).message });
      }
    }

    if (shapeOk.length === 0) return { live: [], skipped };

    // 2) 真发请求探测
    const transientSources = shapeOk.map((c, i) =>
      this.buildTransientSource(topicId, c.type, c.identifier, c.config, i),
    );
    const results = await this.collectorRouter.fanOut(transientSources, {
      since: new Date(Date.now() + 86_400_000),
      perSourceLimit: 1,
      userId,
    });
    const live: typeof shapeOk = [];
    results.forEach((r, i) => {
      const c = shapeOk[i];
      if (!c) return;
      if (r.error) {
        this.log.warn(
          `Preflight drop ${r.type}:${transientSources[i]?.identifier} - ${r.error}`,
        );
        skipped.push({
          type: c.type,
          identifier: c.identifier,
          reason: r.error,
        });
      } else {
        live.push(c);
      }
    });
    return { live, skipped };
  }

  /**
   * 批量入库数据源 —— AI 推荐 accept 与手工批量导入共用，仅 `opts.isAiRecommended` 不同
   * （手工源标成 AI 推荐会污染后续按来源筛选 / AI 推荐质量评估）。
   *
   * R7 2026-05-19：preflight 抽公共 method 后，本方法简化为 preflightCandidates +
   * 入库。推荐阶段已 preflight 过的候选再次调本方法时 preflight 会重复一次 —— 接受 trade-off：
   * 1) 推荐到 accept 可能间隔几分钟，源状态可能变（再 preflight 兜底）
   * 2) preflight 并发，开销可接受
   * 3) 不改 accept 路径行为兼容现有 e2e 测试
   *
   * 返回值含 `skipped`：前端提示用户"接受 N，过滤 M 个不可达"。单条 P2002 降级进
   * skipped 而非抛 409，避免一条重复源让整批失败。
   */
  async bulkCreate(
    userId: string,
    topicId: string,
    candidates: Array<{
      type: CreatableRadarSourceTypeDto;
      identifier: string;
      label?: string;
      config?: Record<string, unknown>;
      authorityWeight?: number;
      enabled?: boolean;
    }>,
    opts: { isAiRecommended: boolean },
  ): Promise<{
    created: RadarSource[];
    skipped: Array<{ type: string; identifier: string; reason: string }>;
  }> {
    await this.topics.getOwnedById(userId, topicId);

    const { live: shapeOk, skipped } = await this.preflightCandidates(
      topicId,
      userId,
      candidates,
    );

    // 入库
    const created: RadarSource[] = [];
    for (const c of shapeOk) {
      try {
        const source = await this.prisma.radarSource.create({
          data: {
            topicId,
            type: c.type,
            identifier: c.identifier,
            label: c.label?.trim() ?? null,
            config:
              c.config === undefined
                ? Prisma.JsonNull
                : (c.config as Prisma.InputJsonValue),
            enabled: c.enabled ?? true,
            // undefined 时交给 Prisma `@default(3)`，与 create() 同写法
            authorityWeight: c.authorityWeight,
            isAiRecommended: opts.isAiRecommended,
            isPublicSource: isPublicSource({
              type: c.type,
              identifier: c.identifier,
              config: c.config ?? null,
            }),
          },
        });
        created.push(source);
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          skipped.push({
            type: c.type,
            identifier: c.identifier,
            reason: "已存在同 type+identifier 数据源",
          });
          continue;
        }
        throw error;
      }
    }
    return { created, skipped };
  }

  /**
   * 构造未入库的 RadarSource 临时对象供 CollectorRouter.fanOut() preflight。
   * 仅填 collector.fetch() 必读的字段；id/topicId/timestamps 用占位。
   */
  private buildTransientSource(
    topicId: string,
    type: RadarSourceType,
    identifier: string,
    config: Record<string, unknown> | undefined,
    seq: number,
  ): RadarSource {
    const now = new Date();
    return {
      id: `preflight-${seq}`,
      topicId,
      type,
      identifier,
      label: null,
      config: (config ?? null) as Prisma.JsonValue,
      enabled: true,
      isAiRecommended: true,
      health: "UNKNOWN",
      consecutiveFailures: 0,
      cooldownUntil: null,
      lastFetchAt: null,
      lastError: null,
      authorityWeight: 3,
      isPublicSource: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  private assertIdentifierShape(
    type: RadarSourceType,
    identifier: string,
  ): void {
    switch (type) {
      case "X":
        if (!/^@?[A-Za-z0-9_]{1,30}$/.test(identifier)) {
          throw new BadRequestException(
            "X 数据源 identifier 必须是 1-30 位字母数字下划线 handle（可前缀 @）",
          );
        }
        break;
      case "YOUTUBE":
        // 接受 channelId（UC 开头 24 位）或 https://www.youtube.com/channel/UC.../@user URL
        if (
          !/^UC[A-Za-z0-9_-]{22}$/.test(identifier) &&
          !/^https?:\/\/(?:www\.)?youtube\.com\//.test(identifier)
        ) {
          throw new BadRequestException(
            "YouTube 数据源 identifier 必须是 channelId 或 youtube.com URL",
          );
        }
        break;
      case "GITHUB":
        if (
          identifier.length > 500 ||
          /[\u0000-\u001F\u007F]/.test(identifier) ||
          identifier.startsWith("http://") ||
          identifier.startsWith("https://")
        ) {
          throw new BadRequestException(
            "GitHub 数据源 identifier 必须是 trending、owner/repo 或仓库搜索查询，不接受 URL",
          );
        }
        break;
      case "HUGGING_FACE":
        if (
          !/^(?:models|papers)(?::[^\u0000-\u001F\u007F]{1,493})?$/.test(
            identifier,
          )
        ) {
          throw new BadRequestException(
            "Hugging Face identifier 必须是 models、papers、models:<query> 或 papers:<query>",
          );
        }
        break;
      case "RSS":
      case "CUSTOM":
        try {
          assertSafeHttpUrl(identifier);
        } catch (err) {
          throw new BadRequestException((err as Error).message);
        }
        break;
      default:
        throw new BadRequestException(`未知 source type: ${type}`);
    }
  }
}
