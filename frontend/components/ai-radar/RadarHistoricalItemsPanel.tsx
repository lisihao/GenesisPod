'use client';

/**
 * RadarHistoricalItemsPanel —— 已收录信号面板（R13.5 2026-05-19 新增）
 *
 * 背景：daily briefing 只显示「当日 publishedAt 窗口内的高分 item」。Cisco
 * blogs 一天通常 0-2 篇，导致今日 briefing 经常 0 信号 —— 但 DB 里其实
 * 已经存了 N 条历史 item（accepted 或不 accepted）。
 *
 * 本面板直接读 GET /radar/topics/:id/feed?acceptedOnly=true，展示 DB 中
 * 所有已通过评分门槛的 item，让用户看到"系统确实在工作，只是今天没新的"。
 *
 * 设计：
 * - 默认仅显示 accepted=true（已通过 rel≥60+qual≥50 门槛）
 * - 切换 toggle 可看全部（含未通过）便于诊断
 * - 每条显示：title / source / publishedAt / rel/qual 分 / accepted badge
 * - 标题可点击跳原文
 */

import { useEffect, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  Search,
  Sparkles,
} from 'lucide-react';

import { useTranslation } from '@/lib/i18n';
import { analyzeItems, listFeed } from '@/services/ai-radar/api';
import { EmptyState } from '@/components/ui/states/EmptyState';
import type { AdHocInsightResult, RadarItem } from '@/services/ai-radar/types';

/** 与后端 AD_HOC_MAX_ITEMS 对齐：超了后端会 400，不如在这里就拦住 */
const MAX_SELECTED = 30;

interface Props {
  topicId: string;
}

export function RadarHistoricalItemsPanel({ topicId }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<RadarItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [acceptedOnly, setAcceptedOnly] = useState(true);
  // 搜索框即时值 vs 真正发请求的值：不 debounce 会每敲一个字打一次接口
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [result, setResult] = useState<AdHocInsightResult | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(queryInput), 300);
    return () => clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listFeed(topicId, { acceptedOnly, q: query || undefined, limit: 30 })
      .then((resp) => {
        if (cancelled) return;
        setItems(resp.items);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [topicId, acceptedOnly, query]);

  const acceptedCount = items.filter((i) => i.accepted).length;

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_SELECTED) next.add(id);
      return next;
    });
  }

  async function runAnalysis() {
    if (selected.size === 0 || analyzing) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    setResult(null);
    try {
      setResult(await analyzeItems(topicId, [...selected]));
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-gray-200 bg-white">
      {/* Header */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
      >
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-gray-800">已收录信号</h3>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
            {items.length}
            {acceptedOnly && ` 已入选`}
          </span>
          {!acceptedOnly && acceptedCount > 0 && (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              {acceptedCount} 已入选
            </span>
          )}
        </div>
        {collapsed ? (
          <ChevronDown className="h-4 w-4 text-gray-400" />
        ) : (
          <ChevronUp className="h-4 w-4 text-gray-400" />
        )}
      </button>

      {!collapsed && (
        <div className="border-t border-gray-100 p-4">
          {/* Filter toggle */}
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs leading-relaxed text-gray-500">
              DB
              中所有已采集并评分的内容。每日精选只展示当日发布的高分信号，本面板列出全部历史。
            </p>
            <div className="flex items-center gap-1 rounded-md border border-gray-200 p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setAcceptedOnly(true)}
                className={`rounded px-2 py-0.5 font-medium ${
                  acceptedOnly
                    ? 'bg-violet-100 text-violet-700'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                仅已入选
              </button>
              <button
                type="button"
                onClick={() => setAcceptedOnly(false)}
                className={`rounded px-2 py-0.5 font-medium ${
                  !acceptedOnly
                    ? 'bg-violet-100 text-violet-700'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                全部
              </button>
            </div>
          </div>

          {/* 搜索：标题 / 作者。后端不搜字幕正文（无全文索引时等于全表扫长文本） */}
          <div className="mb-3 flex items-center gap-2 rounded-md border border-gray-200 px-2 py-1.5 focus-within:border-violet-300">
            <Search className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
            <input
              type="text"
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              placeholder={t('radar.itemsPanel.searchPlaceholder')}
              className="w-full bg-transparent text-xs text-gray-700 outline-none placeholder:text-gray-400"
            />
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8 text-sm text-gray-400">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载中…
            </div>
          ) : error ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              <AlertCircle className="mr-1 inline-block h-3 w-3" />
              加载失败：{error}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              size="sm"
              title="暂无信号"
              description={
                acceptedOnly
                  ? 'DB 中尚无已入选的信号 — 试试点上方的"重新精选"，等评分跑完后回来看'
                  : 'DB 中没有任何已采集的 item'
              }
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <HistoricalItemRow
                  key={item.id}
                  item={item}
                  selected={selected.has(item.id)}
                  disabled={
                    !selected.has(item.id) && selected.size >= MAX_SELECTED
                  }
                  onToggle={() => toggleSelected(item.id)}
                />
              ))}
            </ul>
          )}

          {selected.size > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-violet-200 bg-violet-50 px-3 py-2">
              <span className="text-xs font-medium text-violet-800">
                {t('radar.itemsPanel.selectedCount', { count: selected.size })}
              </span>
              {selected.size >= MAX_SELECTED && (
                <span className="text-[11px] text-violet-600">
                  {t('radar.itemsPanel.selectionFull', { max: MAX_SELECTED })}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="rounded px-2 py-1 text-xs text-violet-700 hover:bg-violet-100"
                >
                  {t('radar.itemsPanel.clearSelection')}
                </button>
                <button
                  type="button"
                  onClick={() => void runAnalysis()}
                  disabled={analyzing}
                  className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-60"
                >
                  {analyzing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {t('radar.itemsPanel.analyzeSelected')}
                </button>
              </div>
            </div>
          )}

          {analyzeError && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              <AlertCircle className="mr-1 inline-block h-3 w-3" />
              {t('radar.itemsPanel.analyzeFailed', { message: analyzeError })}
            </div>
          )}

          {result && <AdHocResultPanel result={result} />}
        </div>
      )}
    </section>
  );
}

/**
 * 按需分析结果。与定时洞察同构（summary / highlights / signals），
 * 差别只是范围由用户选集界定。
 */
function AdHocResultPanel({ result }: { result: AdHocInsightResult }) {
  const { t } = useTranslation();
  return (
    <section className="mt-3 rounded-lg border border-violet-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-violet-600" />
        <h4 className="text-sm font-semibold text-gray-800">
          {t('radar.itemsPanel.resultTitle', { count: result.itemCount })}
        </h4>
      </div>
      <p className="text-xs leading-relaxed text-gray-700">{result.summary}</p>

      {result.highlights.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {result.highlights.map((h, i) => (
            <li key={i} className="text-xs text-gray-600">
              <span className="mr-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                {h.type}
              </span>
              {h.title}
            </li>
          ))}
        </ul>
      )}

      {result.signals.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 border-t border-gray-100 pt-2">
          {result.signals.map((sig, i) => (
            <li key={i} className="text-xs text-gray-600">
              <span className="font-medium text-gray-800">{sig.kind}</span>
              <span className="font-mono ml-1 text-[10px] text-violet-700">
                {sig.magnitude}/10
              </span>
              <span className="ml-1">— {sig.evidence}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoricalItemRow({
  item,
  selected,
  disabled,
  onToggle,
}: {
  item: RadarItem;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const date = formatDate(item.publishedAt);
  const sourceLabel = item.source?.label ?? item.source?.identifier ?? '未知源';

  return (
    <li
      className={`rounded-lg border px-3 py-2 ${
        selected
          ? 'border-violet-300 bg-violet-50/60'
          : 'border-gray-100 bg-gray-50/40'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={onToggle}
          aria-label={t('radar.itemsPanel.selectItem', {
            title: item.title ?? '',
          })}
          className="mt-1 h-3.5 w-3.5 flex-shrink-0 accent-violet-600 disabled:opacity-40"
        />
        <div className="min-w-0 flex-1">
          {item.url ? (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-start gap-1 text-sm font-medium text-gray-900 hover:text-violet-700 hover:underline"
            >
              <span className="line-clamp-1">{item.title ?? '(无标题)'}</span>
              <ExternalLink className="mt-0.5 h-3 w-3 flex-shrink-0 opacity-60" />
            </a>
          ) : (
            <span className="line-clamp-1 text-sm font-medium text-gray-900">
              {item.title ?? '(无标题)'}
            </span>
          )}
          {item.aiSummary && (
            <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-gray-500">
              {item.aiSummary}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-gray-500">
            <span className="truncate">{sourceLabel}</span>
            <span>·</span>
            <span>{date}</span>
            <span>·</span>
            <span>
              相关性{' '}
              <span className="font-mono text-gray-700">
                {item.relevanceScore ?? '—'}
              </span>
            </span>
            {item.qualityScore != null && (
              <>
                <span>·</span>
                <span>
                  质量{' '}
                  <span className="font-mono text-gray-700">
                    {item.qualityScore}
                  </span>
                </span>
              </>
            )}
          </div>
        </div>
        <span
          className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${
            item.accepted
              ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
              : 'bg-gray-50 text-gray-500 ring-gray-200'
          }`}
        >
          {item.accepted ? '已入选' : '未入选'}
        </span>
      </div>
    </li>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // UTC 时区以避免 SSR/CSR hydration mismatch
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
