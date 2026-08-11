'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Bot,
  ExternalLink,
  Github,
  Loader2,
  RefreshCw,
  Search,
  UsersRound,
  Youtube,
  type LucideIcon,
} from 'lucide-react';

import { PageHeaderHero } from '@/components/ui/page-header-hero';
import { EmptyState } from '@/components/ui/states/EmptyState';
import { listFeed, listSources, listTopics } from '@/services/ai-radar/api';
import type {
  RadarItem,
  RadarSource,
  RadarTopicWithCounts,
} from '@/services/ai-radar/types';
import {
  INSIGHT_MODULES,
  resolveInsightModuleTopic,
  type InsightModuleKey,
} from '@/lib/constants/insight-modules';

const PAGE_SIZE = 40;

const MODULE_ICONS: Record<InsightModuleKey, LucideIcon> = {
  github: Github,
  huggingFace: Bot,
  youtube: Youtube,
  creators: UsersRound,
};

interface InsightModulePageProps {
  moduleKey: InsightModuleKey;
}

export function InsightModulePage({ moduleKey }: InsightModulePageProps) {
  const config = INSIGHT_MODULES[moduleKey];
  const Icon = MODULE_ICONS[moduleKey];
  const [topic, setTopic] = useState<RadarTopicWithCounts | null>(null);
  const [sources, setSources] = useState<RadarSource[]>([]);
  const [items, setItems] = useState<RadarItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadModule = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const primary = await listTopics({
        q: config.searchQuery,
        limit: 60,
      });
      let resolved = resolveInsightModuleTopic(primary.items, moduleKey);
      if (!resolved) {
        const fallback = await listTopics({ limit: 60 });
        resolved = resolveInsightModuleTopic(fallback.items, moduleKey);
      }
      if (!resolved) {
        setTopic(null);
        setSources([]);
        setItems([]);
        setNextCursor(null);
        return;
      }

      const [moduleSources, feed] = await Promise.all([
        listSources(resolved.id),
        listFeed(resolved.id, {
          type: config.sourceType,
          acceptedOnly: true,
          limit: PAGE_SIZE,
        }),
      ]);
      setTopic(resolved);
      setSources(moduleSources);
      setItems(feed.items);
      setNextCursor(feed.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [config.searchQuery, config.sourceType, moduleKey]);

  useEffect(() => {
    void loadModule();
  }, [loadModule]);

  const loadMore = async () => {
    if (!topic || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const feed = await listFeed(topic.id, {
        type: config.sourceType,
        acceptedOnly: true,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      setItems((current) => {
        const known = new Set(current.map((item) => item.id));
        return [
          ...current,
          ...feed.items.filter((item) => !known.has(item.id)),
        ];
      });
      setNextCursor(feed.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingMore(false);
    }
  };

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return items;
    return items.filter((item) => {
      const searchable = [
        item.title,
        item.author,
        item.aiSummary,
        item.content,
      ].filter((value): value is string => typeof value === 'string');
      return searchable.some((value) =>
        value.toLocaleLowerCase().includes(normalized)
      );
    });
  }, [items, query]);

  const healthySources = sources.filter(
    (source) => source.health === 'HEALTHY'
  ).length;

  return (
    <div className="h-full overflow-auto bg-gray-50">
      <div className="sticky top-0 z-10 border-b border-gray-100 bg-white/90 backdrop-blur-sm">
        <PageHeaderHero
          title={config.title}
          subtitle={config.subtitle}
          icon={<Icon className="h-7 w-7 text-white" />}
          iconGradient={config.accent.gradient}
          iconShadowClass={config.accent.shadow}
          actions={
            <button
              type="button"
              onClick={() => void loadModule()}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
              />
              刷新页面
            </button>
          }
        >
          <div className="relative">
            <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`搜索已加载的${config.title}内容…`}
              className="w-full rounded-xl border border-gray-200 bg-white py-3 pl-12 pr-4 text-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20"
            />
          </div>
        </PageHeaderHero>
      </div>

      <main className="mx-auto w-full max-w-7xl px-5 py-6 sm:px-8">
        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void loadModule()} />
        ) : !topic ? (
          <EmptyState
            title={`${config.title}尚未初始化`}
            description="没有找到该独立模块对应的 GenesisPod 数据主题。请先完成历史数据初始化。"
          />
        ) : (
          <>
            <ModuleStats
              topic={topic}
              sourceCount={sources.length}
              healthySources={healthySources}
              loadedCount={items.length}
              accentBg={config.accent.softBg}
              accentText={config.accent.text}
            />

            <section className="mt-6 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
                <div>
                  <h2 className="text-base font-semibold text-gray-900">
                    最新内容
                  </h2>
                  <p className="mt-0.5 text-xs text-gray-500">
                    当前显示 {visibleItems.length} 条，已加载 {items.length} /{' '}
                    {formatCount(topic.counts.items)} 条
                  </p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${config.accent.softBg} ${config.accent.text}`}
                >
                  GenesisPod 原生数据
                </span>
              </div>

              {visibleItems.length === 0 ? (
                <div className="p-10">
                  <EmptyState
                    size="sm"
                    title={query ? '没有匹配内容' : '暂无历史内容'}
                    description={
                      query ? '换个关键词试试。' : '该模块目前没有已入选条目。'
                    }
                  />
                </div>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {visibleItems.map((item) => (
                    <InsightItemRow key={item.id} item={item} />
                  ))}
                </ul>
              )}

              {nextCursor && !query && (
                <div className="border-t border-gray-100 p-4 text-center">
                  <button
                    type="button"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                    className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-5 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {loadingMore && (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                    加载更多
                  </button>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function ModuleStats({
  topic,
  sourceCount,
  healthySources,
  loadedCount,
  accentBg,
  accentText,
}: {
  topic: RadarTopicWithCounts;
  sourceCount: number;
  healthySources: number;
  loadedCount: number;
  accentBg: string;
  accentText: string;
}) {
  const statusLabel =
    topic.status === 'ACTIVE'
      ? '自动更新中'
      : topic.status === 'PAUSED'
        ? '已暂停自动更新'
        : '已归档';
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="历史条目" value={formatCount(topic.counts.items)} />
      <StatCard label="独立来源" value={formatCount(sourceCount)} />
      <StatCard label="健康来源" value={`${healthySources}/${sourceCount}`} />
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <p className="text-xs font-medium text-gray-500">模块状态</p>
        <span
          className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-sm font-semibold ${accentBg} ${accentText}`}
        >
          {statusLabel}
        </span>
        <p className="mt-2 text-xs text-gray-400">
          本页已加载 {loadedCount} 条
        </p>
      </div>
    </section>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-gray-950">
        {value}
      </p>
    </div>
  );
}

function InsightItemRow({ item }: { item: RadarItem }) {
  const summary = item.aiSummary || item.content;
  const sourceLabel = item.source?.label || item.source?.identifier;
  const metrics = Object.entries(item.metrics ?? {})
    .filter(([, value]) => value !== null && value !== undefined)
    .slice(0, 4);

  return (
    <li className="px-5 py-4 transition hover:bg-gray-50/80">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
            {sourceLabel && <span>{sourceLabel}</span>}
            {item.author && <span>· {item.author}</span>}
            <span>· {formatPublishedAt(item.publishedAt)}</span>
          </div>
          {item.url ? (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-flex max-w-full items-start gap-1.5 text-sm font-semibold text-gray-950 hover:text-cyan-700"
            >
              <span className="line-clamp-2">{item.title || '(无标题)'}</span>
              <ExternalLink className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            </a>
          ) : (
            <h3 className="mt-1.5 line-clamp-2 text-sm font-semibold text-gray-950">
              {item.title || '(无标题)'}
            </h3>
          )}
          {summary && (
            <p className="mt-2 line-clamp-3 text-xs leading-5 text-gray-600">
              {summary}
            </p>
          )}
          {metrics.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {metrics.map(([key, value]) => (
                <span
                  key={key}
                  className="rounded-md bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600"
                >
                  {metricLabel(key)} {formatMetric(value)}
                </span>
              ))}
            </div>
          )}
        </div>
        <span className="flex-shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200">
          已入选
        </span>
      </div>
    </li>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="h-24 animate-pulse rounded-2xl border border-gray-200 bg-white"
          />
        ))}
      </div>
      <div className="h-96 animate-pulse rounded-2xl border border-gray-200 bg-white" />
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-red-800">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
        <div>
          <p className="font-medium">模块加载失败</p>
          <p className="mt-1 text-sm">{message}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 rounded-lg bg-white px-3 py-1.5 text-sm font-medium shadow-sm ring-1 ring-red-200"
          >
            重试
          </button>
        </div>
      </div>
    </div>
  );
}

function formatPublishedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

function metricLabel(key: string): string {
  const labels: Record<string, string> = {
    stars: 'Stars',
    forks: 'Forks',
    views: '浏览',
    likes: '点赞',
    comments: '评论',
    reposts: '转发',
    quotes: '引用',
    downloads: '下载',
  };
  return labels[key] ?? key;
}

function formatMetric(value: number | string): string {
  return typeof value === 'number'
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)
    : value;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}
