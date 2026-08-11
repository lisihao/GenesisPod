import type {
  RadarSourceType,
  RadarTopicWithCounts,
} from '@/services/ai-radar/types';

export const INSIGHT_MIGRATION_MARKER = 'solar-harness-insight-history-v1';

export type InsightModuleKey =
  | 'github'
  | 'huggingFace'
  | 'youtube'
  | 'creators';

export interface InsightModuleConfig {
  key: InsightModuleKey;
  href: string;
  navLabelKey: string;
  title: string;
  subtitle: string;
  topicNames: readonly string[];
  sourceType: RadarSourceType;
  searchQuery: string;
  accent: {
    gradient: string;
    shadow: string;
    softBg: string;
    text: string;
  };
}

export const INSIGHT_MODULES: Record<InsightModuleKey, InsightModuleConfig> = {
  github: {
    key: 'github',
    href: '/insights/github',
    navLabelKey: 'nav.githubTrends',
    title: 'GitHub 趋势',
    subtitle: '跟踪开源项目热度、增长信号和技术趋势',
    topicNames: ['GitHub 趋势（Solar 历史）', 'GitHub 趋势'],
    sourceType: 'GITHUB',
    searchQuery: 'GitHub 趋势',
    accent: {
      gradient: 'from-slate-700 to-slate-950',
      shadow: 'shadow-slate-500/25',
      softBg: 'bg-slate-50',
      text: 'text-slate-700',
    },
  },
  huggingFace: {
    key: 'huggingFace',
    href: '/insights/hugging-face',
    navLabelKey: 'nav.huggingFaceInsights',
    title: 'Hugging Face',
    subtitle: '聚合 AI 论文、模型动向和社区热度变化',
    topicNames: ['Hugging Face 论文（Solar 历史）', 'Hugging Face 论文'],
    sourceType: 'HUGGING_FACE',
    searchQuery: 'Hugging Face 论文',
    accent: {
      gradient: 'from-amber-400 to-orange-500',
      shadow: 'shadow-amber-500/25',
      softBg: 'bg-amber-50',
      text: 'text-amber-700',
    },
  },
  youtube: {
    key: 'youtube',
    href: '/insights/youtube',
    navLabelKey: 'nav.youtubeInsights',
    title: 'YouTube 洞察',
    subtitle: '汇总技术频道、视频证据和字幕中的关键观点',
    topicNames: ['YouTube 洞察（Solar 历史）', 'YouTube 洞察'],
    sourceType: 'YOUTUBE',
    searchQuery: 'YouTube 洞察',
    accent: {
      gradient: 'from-red-500 to-rose-600',
      shadow: 'shadow-red-500/25',
      softBg: 'bg-red-50',
      text: 'text-red-700',
    },
  },
  creators: {
    key: 'creators',
    href: '/insights/creators',
    navLabelKey: 'nav.creatorInsights',
    title: '大咖洞察',
    subtitle: '持续追踪行业人物观点、立场变化和跨来源信号',
    topicNames: ['大咖洞察（Solar 历史）', '大咖洞察'],
    sourceType: 'X',
    searchQuery: '大咖洞察',
    accent: {
      gradient: 'from-violet-500 to-fuchsia-600',
      shadow: 'shadow-violet-500/25',
      softBg: 'bg-violet-50',
      text: 'text-violet-700',
    },
  },
};

export const INSIGHT_MODULE_LIST = Object.values(INSIGHT_MODULES);

function topicNameMatches(
  topic: Pick<RadarTopicWithCounts, 'name'>,
  config: InsightModuleConfig
): boolean {
  return config.topicNames.includes(topic.name);
}

export function resolveInsightModuleTopic(
  topics: RadarTopicWithCounts[],
  moduleKey: InsightModuleKey
): RadarTopicWithCounts | null {
  const config = INSIGHT_MODULES[moduleKey];
  const named = topics.filter((topic) => topicNameMatches(topic, config));
  if (named.length === 0) return null;

  return (
    named.find((topic) =>
      topic.description?.includes(INSIGHT_MIGRATION_MARKER)
    ) ?? named[0]
  );
}

export function isDedicatedInsightTopic(
  topic: Pick<RadarTopicWithCounts, 'name'>
): boolean {
  return INSIGHT_MODULE_LIST.some((config) => topicNameMatches(topic, config));
}
