import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../../common/guards/jwt-auth.guard";
import { PrismaService } from "../../../../../common/prisma/prisma.service";
import type { RequestWithUser } from "../../../../../common/types/express-request.types";
import { RadarTopicService } from "../../mission/services/topic/radar-topic.service";
import { RadarAdHocInsightService } from "../../mission/services/insight/radar-ad-hoc-insight.service";
import { AnalyzeRadarItemsDto } from "../dto/analyze-radar-items.dto";

@Controller("radar")
@UseGuards(JwtAuthGuard)
export class RadarInsightController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly topics: RadarTopicService,
    private readonly adHoc: RadarAdHocInsightService,
  ) {}

  @Get("topics/:topicId/insights")
  async list(
    @Request() req: RequestWithUser,
    @Param("topicId") topicId: string,
    @Query("limit", new DefaultValuePipe(20), ParseIntPipe) limit: number,
    /** 省略 = 全部；'scheduled' 只看周期洞察；'ad-hoc' 只看手动分析 */
    @Query("kind") kind?: string,
  ) {
    await this.topics.getOwnedById(req.user.id, topicId);
    const cap = Math.min(Math.max(limit, 1), 100);
    return this.prisma.radarInsight.findMany({
      where: {
        topicId,
        ...(kind === "scheduled" || kind === "ad-hoc" ? { kind } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: cap,
    });
  }

  /**
   * 按需分析：用户在 feed 勾选一批内容后手动触发。
   *
   * 与定时洞察走同一套合成逻辑和证据门禁，产物是 kind='ad-hoc' 的 RadarInsight。
   * 同步返回——单次 LLM 调用，不值得为它开一条 mission。
   */
  @Post("topics/:topicId/insights/analyze")
  async analyze(
    @Request() req: RequestWithUser,
    @Param("topicId") topicId: string,
    @Body() dto: AnalyzeRadarItemsDto,
  ) {
    return this.adHoc.analyze(req.user.id, topicId, dto.itemIds);
  }

  @Get("topics/:topicId/insights/latest")
  async latest(
    @Request() req: RequestWithUser,
    @Param("topicId") topicId: string,
  ) {
    await this.topics.getOwnedById(req.user.id, topicId);
    const insight = await this.prisma.radarInsight.findFirst({
      where: { topicId },
      orderBy: { periodTo: "desc" },
    });
    return { insight };
  }
}
