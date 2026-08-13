/**
 * Radar 主题分析模式
 *
 * auto（默认，存量行为不变）
 *   定时 refresh mission 跑完整 S1-S8，并进入每日精选调度。
 *
 * on-demand（YouTube 大咖类主题）
 *   定时链路只跑到 S4 相关性就停——采集 + 字幕照常天天做，S5 质量 / S6 实体 /
 *   S7 洞察这三步 LLM 不自动跑，每日精选也不排期。分析改由用户在 feed 里勾选
 *   一批 item 手动触发（ad-hoc insight）。
 *
 * 为什么 on-demand 仍保留 S4：没有 relevanceScore 的 feed 只能按时间平铺，
 * 视频一多就没法挑；S4 是一次批量调用，成本远低于逐条摘要的 S5。
 */
export const RADAR_ANALYSIS_MODE = {
  AUTO: "auto",
  ON_DEMAND: "on-demand",
} as const;

export type RadarAnalysisMode =
  (typeof RADAR_ANALYSIS_MODE)[keyof typeof RADAR_ANALYSIS_MODE];

export function isRadarAnalysisMode(
  value: unknown,
): value is RadarAnalysisMode {
  return (
    value === RADAR_ANALYSIS_MODE.AUTO ||
    value === RADAR_ANALYSIS_MODE.ON_DEMAND
  );
}

/**
 * 未知值一律按 auto 处理：analysisMode 是 VarChar 不是 enum，脏数据不能让
 * 主题静默停止分析（那正是这次要消灭的失败模式）。
 */
export function isOnDemandAnalysis(
  topic: { analysisMode?: string | null } | null | undefined,
): boolean {
  return topic?.analysisMode === RADAR_ANALYSIS_MODE.ON_DEMAND;
}
