import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from "class-validator";
import { AD_HOC_MAX_ITEMS } from "../../mission/services/insight/radar-ad-hoc-insight.service";

/**
 * 按需分析入参：用户在 feed 里勾选的一批 RadarItem。
 *
 * 上限与 S7 单次喂给 LLM 的条数一致；归属校验在 service 内做（只认真正属于
 * 该 topic 的 id），DTO 这层只管形状。
 */
export class AnalyzeRadarItemsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(AD_HOC_MAX_ITEMS)
  @IsUUID("4", { each: true })
  itemIds!: string[];
}
