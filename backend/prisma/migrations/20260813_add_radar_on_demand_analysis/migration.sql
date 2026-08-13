-- Radar 按需分析（on-demand analysis）
--
-- 背景：YouTube 大咖类主题的价值在于「字幕天天采」，而不是「每 6 小时自动分析一遍」。
-- 定时链路对这类主题跑到 S4 相关性即停，S5 质量 / S6 实体 / S7 洞察与每日精选都不自动跑；
-- 分析改由用户在 feed 里勾选一批 item 手动触发。
--
-- 两张表都只加列、带默认值，存量行语义不变（analysis_mode='auto' / kind='scheduled'）。

-- 主题级开关：auto（默认，行为与现状完全一致）| on-demand
ALTER TABLE "radar_topics"
  ADD COLUMN IF NOT EXISTS "analysis_mode" VARCHAR(20) NOT NULL DEFAULT 'auto';

-- 洞察来源区分 + ad-hoc 的选集范围
ALTER TABLE "radar_insights"
  ADD COLUMN IF NOT EXISTS "kind" VARCHAR(20) NOT NULL DEFAULT 'scheduled';

ALTER TABLE "radar_insights"
  ADD COLUMN IF NOT EXISTS "item_ids" JSONB;

-- feed 按 kind 拉「该主题的历次手动分析」时走这条索引；
-- 现有 (topic_id, period_to DESC) 索引服务于 scheduled 的时间线查询，两者不冲突。
CREATE INDEX IF NOT EXISTS "radar_insights_topic_id_kind_created_at_idx"
  ON "radar_insights" ("topic_id", "kind", "created_at" DESC);
