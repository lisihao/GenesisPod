'use client';

import { useMemo, useState } from 'react';
import {
  AlertCircle,
  ClipboardList,
  Plus,
  Power,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { EmptyState } from '@/components/ui/states/EmptyState';
import { ErrorInline } from '@/components/ui/states/ErrorState';
import { Modal } from '@/components/ui/dialogs/Modal';
import { Textarea } from '@/components/ui/form/Textarea';
import { useTranslation } from '@/lib/i18n';
import {
  acceptRecommendedSources,
  bulkCreateSources,
  createSource,
  deleteSource,
  recommendSources,
  updateSource,
} from '@/services/ai-radar/api';
import type {
  CreatableRadarSourceType,
  RadarSource,
  RadarSourceType,
  RecommendedSource,
} from '@/services/ai-radar/types';
import { ConfirmDialog } from '@/components/ui/dialogs/ConfirmDialog';

interface Props {
  topicId: string;
  sources: RadarSource[];
  onReload: () => void;
}

/** useTranslation().t 的签名，用于把 t 传进模块级纯函数（parseSourceLines） */
type Translate = (
  key: string,
  params?: Record<string, string | number>
) => string;

const SOURCE_TYPE_LABEL: Record<RadarSourceType, string> = {
  X: 'X (Twitter)',
  YOUTUBE: 'YouTube',
  GITHUB: 'GitHub',
  HUGGING_FACE: 'Hugging Face',
  RSS: 'RSS',
  CUSTOM: '自定义',
};

// 2026-05-17：AddSourceForm / AI 推荐都禁 X（业界主流 Feedly/Inoreader
// 已淡化 X 集成 + Nitter 全死 + 不让用户配 X API key）。source-curator
// 把 X KOL 转换为等价 RSS / YouTube / Newsletter 推荐。RadarSourceType.X
// 枚举仅兼容历史 X 源 list 渲染 + cooldown 自然降级（顶部黄条提示替换）。
const ADDABLE_SOURCE_TYPES: CreatableRadarSourceType[] = [
  'RSS',
  'YOUTUBE',
  'GITHUB',
  'HUGGING_FACE',
  'CUSTOM',
];

const SOURCE_TYPE_WARNING: Partial<Record<CreatableRadarSourceType, string>> = {
  CUSTOM:
    '需在「显示名」后的 config.listSelector 提供 CSS 选择器，否则采集会失败。',
};

const HEALTH_DOT: Record<RadarSource['health'], string> = {
  UNKNOWN: 'bg-gray-300',
  HEALTHY: 'bg-emerald-500',
  DEGRADED: 'bg-amber-500',
  FAILING: 'bg-red-500',
};

// 与后端 @IsInt @Min(1) @Max(5) 值域对齐；添加表单与行内编辑共用，避免文案漂移。
// 文案在 i18n radar.sourceList.authorityOption.w{n}。
const AUTHORITY_WEIGHT_VALUES = [5, 4, 3, 2, 1];

// 批量导入：后端 BulkCreateRadarSourcesDto 是 @ArrayMinSize(1) @ArrayMaxSize(20)，
// 越界整批 400，所以提交前必须本地拦住。
const BULK_IMPORT_MAX = 20;

// 与后端 CreateRadarSourceDto 的 @MaxLength 对齐，超长同样是整批 400
const IDENTIFIER_MAX_LENGTH = 500;
const LABEL_MAX_LENGTH = 200;

interface ParsedSourceLine {
  /** 1-based 原始行号，用于把后端/本地错误定位回粘贴文本 */
  lineNo: number;
  type: CreatableRadarSourceType;
  identifier: string;
  label?: string;
  /** 省略时不下发，走 DB @default(3) */
  authorityWeight?: number;
}

interface SourceLineIssue {
  lineNo: number;
  reason: string;
}

function isCreatableType(v: string): v is CreatableRadarSourceType {
  return ADDABLE_SOURCE_TYPES.some((t) => t === v);
}

/**
 * 解析「每行一条、竖线分隔」的粘贴文本：`type | identifier | 显示名 | 权威度`。
 *
 * 分隔符选 `|`：RFC 3986 把它排除在合法 URI 字符外（浏览器会 percent-encode 成
 * %7C），真实 feed URL 不会裸出现；而 `,` `;` `&` `=` `:` 都可能出现在 query
 * string 里。identifier 只做两端 trim，内部 `?key=a&b=1,2` 原样保留。
 *
 * 校验只做与后端 assertIdentifierShape 同级的轻量判断（非空 / http(s) 前缀 /
 * channelId shape），**不复制 SSRF 白名单与 preflight**，那些交后端进 skipped。
 */
function parseSourceLines(
  text: string,
  existing: ReadonlyArray<Pick<RadarSource, 'type' | 'identifier'>>,
  t: Translate
): {
  valid: ParsedSourceLine[];
  duplicates: SourceLineIssue[];
  issues: SourceLineIssue[];
} {
  const seen = new Set(existing.map((s) => `${s.type}\u0000${s.identifier}`));
  const valid: ParsedSourceLine[] = [];
  const duplicates: SourceLineIssue[] = [];
  const issues: SourceLineIssue[] = [];

  text.split('\n').forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    // # 开头当注释，方便直接从文档整段粘贴
    if (!line || line.startsWith('#')) return;

    const parts = line.split('|');
    const field = (idx: number) =>
      parts.length > idx ? parts[idx].trim() : '';
    if (parts.length > 4) {
      issues.push({
        lineNo,
        reason: t('radar.sourceList.issue.tooManyFields'),
      });
      return;
    }

    const type = field(0).toUpperCase();
    if (!isCreatableType(type)) {
      issues.push({
        lineNo,
        reason: t('radar.sourceList.issue.unknownType', { type: field(0) }),
      });
      return;
    }

    const identifier = field(1);
    if (!identifier) {
      issues.push({
        lineNo,
        reason: t('radar.sourceList.issue.missingIdentifier'),
      });
      return;
    }
    // 与后端 CreateRadarSourceDto 的 @MaxLength(500) 对齐：超长会让整批 400
    if (identifier.length > IDENTIFIER_MAX_LENGTH) {
      issues.push({
        lineNo,
        reason: t('radar.sourceList.issue.identifierTooLong', {
          max: IDENTIFIER_MAX_LENGTH,
        }),
      });
      return;
    }
    if (type === 'YOUTUBE') {
      // 与后端 assertIdentifierShape 的锚定正则保持一致：host 必须紧跟协议，
      // 不能用子串匹配（`includes('youtube.com')` 会被
      // `https://evil.com/youtube.com` 这类 URL 绕过）。
      if (
        !/^UC[A-Za-z0-9_-]{22}$/.test(identifier) &&
        !/^https?:\/\/(?:www\.)?youtube\.com\//.test(identifier)
      ) {
        issues.push({
          lineNo,
          reason: t('radar.sourceList.issue.youtubeIdentifier'),
        });
        return;
      }
    } else if (
      type !== 'GITHUB' &&
      type !== 'HUGGING_FACE' &&
      !/^https?:\/\//i.test(identifier)
    ) {
      issues.push({
        lineNo,
        reason: t('radar.sourceList.issue.identifierNotUrl', {
          type: SOURCE_TYPE_LABEL[type],
        }),
      });
      return;
    }

    const label = field(2);
    // 与后端 @MaxLength(200) 对齐，同上
    if (label.length > LABEL_MAX_LENGTH) {
      issues.push({
        lineNo,
        reason: t('radar.sourceList.issue.labelTooLong', {
          max: LABEL_MAX_LENGTH,
        }),
      });
      return;
    }

    const weightRaw = field(3);
    let authorityWeight: number | undefined;
    if (weightRaw) {
      const n = Number(weightRaw);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        issues.push({
          lineNo,
          reason: t('radar.sourceList.issue.invalidWeight', {
            value: weightRaw,
          }),
        });
        return;
      }
      authorityWeight = n;
    }

    const key = `${type}\u0000${identifier}`;
    if (seen.has(key)) {
      duplicates.push({ lineNo, reason: `${type}:${identifier}` });
      return;
    }
    seen.add(key);
    valid.push({
      lineNo,
      type,
      identifier,
      label: label || undefined,
      authorityWeight,
    });
  });

  return { valid, duplicates, issues };
}

function relTime(iso: string | null): string {
  if (!iso) return '从未';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

export function RadarSourceList({ topicId, sources, onReload }: Props) {
  const { t } = useTranslation();
  const [addOpen, setAddOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [recommendOpen, setRecommendOpen] = useState(false);
  const [recommending, setRecommending] = useState(false);
  const [candidates, setCandidates] = useState<RecommendedSource[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [opError, setOpError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RadarSource | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [weightSavingId, setWeightSavingId] = useState<string | null>(null);
  // R7 2026-05-19：preflight 信息 —— "AI 生成 X 个候选，已自动过滤 Y 个不可达"
  const [preflightInfo, setPreflightInfo] = useState<{
    total: number;
    skipped: number;
  } | null>(null);

  const handleRecommend = async () => {
    setRecommending(true);
    setRecommendOpen(true);
    setOpError(null);
    setPreflightInfo(null);
    try {
      const result = await recommendSources(topicId, 4);
      setCandidates(result.candidates);
      setSelected(new Set(result.candidates.map((_, i) => i)));
      if (result.skipped.length > 0) {
        setPreflightInfo({
          total: result.totalGenerated,
          skipped: result.skipped.length,
        });
      }
    } catch (e) {
      setOpError(`AI 推荐失败：${e instanceof Error ? e.message : String(e)}`);
      setRecommendOpen(false);
    } finally {
      setRecommending(false);
    }
  };

  // AI 推荐入库 / 手工批量导入两条路径共用这一条 amber 结果条带（同为
  // "created N + skipped M" 语义），避免多加一个同形态的 state。
  const [acceptInfo, setAcceptInfo] = useState<string | null>(null);

  const handleAccept = async () => {
    const picked = candidates.filter((_, i) => selected.has(i));
    if (picked.length === 0) {
      setRecommendOpen(false);
      return;
    }
    setOpError(null);
    setAcceptInfo(null);
    try {
      const result = await acceptRecommendedSources(topicId, picked);
      setRecommendOpen(false);
      // backend preflight 后剔除的源（LLM hallucinate URL / @handle 解析失败
      // / paywall 403 等），让用户知道为什么实际入库 < 选中数
      if (result.skipped.length > 0) {
        const lines = result.skipped
          .slice(0, 5)
          .map((s) => `• ${s.type}:${s.identifier} - ${s.reason}`)
          .join('\n');
        const more =
          result.skipped.length > 5
            ? `\n• 还有 ${result.skipped.length - 5} 条...`
            : '';
        setAcceptInfo(
          `已添加 ${result.created.length} 个源，过滤掉 ${result.skipped.length} 个不可达：\n${lines}${more}`
        );
      } else if (result.created.length > 0) {
        setAcceptInfo(`已添加 ${result.created.length} 个数据源`);
      }
      onReload();
    } catch (e) {
      setOpError(`入库失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleToggleEnable = async (s: RadarSource) => {
    setOpError(null);
    try {
      await updateSource(s.id, { enabled: !s.enabled });
      onReload();
    } catch (e) {
      setOpError(`切换失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleWeightChange = async (s: RadarSource, weight: number) => {
    if (weight === s.authorityWeight) return;
    setWeightSavingId(s.id);
    setOpError(null);
    try {
      await updateSource(s.id, { authorityWeight: weight });
      onReload();
    } catch (e) {
      setOpError(
        t('radar.sourceList.weightUpdateFailed', {
          message: e instanceof Error ? e.message : String(e),
        })
      );
    } finally {
      setWeightSavingId(null);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setOpError(null);
    try {
      await deleteSource(deleteTarget.id);
      setDeleteTarget(null);
      onReload();
    } catch (e) {
      setOpError(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleting(false);
    }
  };

  const hasLegacyX = sources.some((s) => s.type === 'X');

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      {hasLegacyX && (
        <div
          role="status"
          className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="min-w-0 flex-1">
            X (Twitter) 已停止新推荐 —— Nitter 公共代理全部失效。已有的 X
            源会继续保留，但建议删除后通过「AI 推荐」让 LLM 替换为等价的 YouTube
            / 个人 Substack / 官博 RSS。
          </span>
        </div>
      )}
      <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
        <h3 className="text-sm font-medium text-gray-700">
          数据源 ({sources.length})
        </h3>
        <div className="flex gap-1">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-cyan-200 bg-cyan-50 px-2 py-1 text-xs text-cyan-700 hover:bg-cyan-100"
            onClick={handleRecommend}
          >
            <Sparkles className="h-3 w-3" />
            AI 推荐
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
            onClick={() => setBulkOpen(true)}
          >
            <ClipboardList className="h-3 w-3" />
            {t('radar.sourceList.bulkImport')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="h-3 w-3" />
            添加
          </button>
        </div>
      </div>

      {sources.length === 0 ? (
        <EmptyState
          size="sm"
          title={t('radar.sourceList.emptyTitle')}
          description={t('radar.sourceList.emptyDescription')}
        />
      ) : (
        <ul className="divide-y divide-gray-100">
          {sources.map((s) => (
            <li key={s.id} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 flex-shrink-0 rounded-full ${HEALTH_DOT[s.health]}`}
                  title={`health: ${s.health}`}
                />
                <span className="rounded bg-gray-50 px-1.5 py-0.5 text-xs font-medium text-gray-500">
                  {SOURCE_TYPE_LABEL[s.type]}
                </span>
                {s.isAiRecommended && (
                  <span className="rounded bg-cyan-50 px-1.5 py-0.5 text-xs text-cyan-700">
                    AI
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-gray-700">
                  {s.label || s.identifier}
                </span>
                <span className="text-xs text-gray-400">
                  {relTime(s.lastFetchAt)}
                </span>
              </div>
              {s.lastError && (
                <div className="mt-1 flex items-start gap-1 text-xs text-red-600">
                  <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                  <span className="line-clamp-1">{s.lastError}</span>
                </div>
              )}
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  className="text-xs text-gray-500 hover:text-gray-700"
                  onClick={() => handleToggleEnable(s)}
                >
                  <Power className="inline h-3 w-3" />{' '}
                  {s.enabled ? '禁用' : '启用'}
                </button>
                <button
                  type="button"
                  className="text-xs text-red-500 hover:text-red-700"
                  onClick={() => setDeleteTarget(s)}
                >
                  <Trash2 className="inline h-3 w-3" /> 删除
                </button>
                <select
                  className="ml-auto rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-600 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-60"
                  aria-label={t('radar.sourceList.authorityAriaLabel', {
                    name: s.label || s.identifier,
                  })}
                  value={s.authorityWeight}
                  disabled={weightSavingId === s.id}
                  onChange={(e) =>
                    void handleWeightChange(s, Number(e.target.value))
                  }
                >
                  {AUTHORITY_WEIGHT_VALUES.map((v) => (
                    <option key={v} value={v}>
                      {t(`radar.sourceList.authorityOption.w${v}`)}
                    </option>
                  ))}
                </select>
              </div>
            </li>
          ))}
        </ul>
      )}

      {acceptInfo && (
        <div className="mx-3 mb-2 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-sans">
            {acceptInfo}
          </pre>
          <button
            type="button"
            className="text-amber-400 hover:text-amber-600"
            onClick={() => setAcceptInfo(null)}
            aria-label="dismiss info"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {opError && (
        <div className="mx-3 mb-2 flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
          <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span className="min-w-0 flex-1">{opError}</span>
          <button
            type="button"
            className="text-red-400 hover:text-red-600"
            onClick={() => setOpError(null)}
            aria-label="dismiss error"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {addOpen && (
        <AddSourceForm
          topicId={topicId}
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false);
            onReload();
          }}
        />
      )}

      {bulkOpen && (
        <BulkImportDialog
          topicId={topicId}
          existing={sources}
          onClose={() => setBulkOpen(false)}
          onDone={(info) => {
            setBulkOpen(false);
            setAcceptInfo(info);
            onReload();
          }}
        />
      )}

      {recommendOpen && (
        <RecommendDialog
          loading={recommending}
          candidates={candidates}
          selected={selected}
          preflightInfo={preflightInfo}
          onToggle={(i) => {
            const next = new Set(selected);
            if (next.has(i)) next.delete(i);
            else next.add(i);
            setSelected(next);
          }}
          onClose={() => setRecommendOpen(false)}
          onAccept={() => void handleAccept()}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`删除数据源「${deleteTarget?.label || deleteTarget?.identifier || ''}」？`}
        description="历史采集到的条目会保留，但后续不再从该源拉取。"
        confirmText="删除"
        type="danger"
        loading={deleting}
        onConfirm={handleDeleteConfirm}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function AddSourceForm({
  topicId,
  onClose,
  onAdded,
}: {
  topicId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useTranslation();
  const [type, setType] = useState<CreatableRadarSourceType>('RSS');
  const [identifier, setIdentifier] = useState('');
  const [label, setLabel] = useState('');
  const [authorityWeight, setAuthorityWeight] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!identifier.trim()) {
      setError('请填写 identifier');
      return;
    }
    setSubmitting(true);
    try {
      await createSource(topicId, {
        type,
        identifier: identifier.trim(),
        label: label.trim() || undefined,
        config: type === 'YOUTUBE' ? { fetchTranscript: true } : undefined,
        enabled: true,
        authorityWeight,
      });
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-source-dialog-title"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-5">
        <h3
          id="add-source-dialog-title"
          className="mb-3 text-sm font-semibold text-gray-900"
        >
          添加数据源
        </h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-600">类型</label>
            <div className="mt-1 flex gap-1">
              {ADDABLE_SOURCE_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`rounded-md border px-2.5 py-1 text-xs ${
                    type === t
                      ? 'border-cyan-300 bg-cyan-50 text-cyan-700'
                      : 'border-gray-200 text-gray-600'
                  }`}
                  onClick={() => setType(t)}
                >
                  {SOURCE_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
            {SOURCE_TYPE_WARNING[type] && (
              <div className="mt-1.5 flex items-start gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-1 text-xs text-amber-700">
                <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                <span>{SOURCE_TYPE_WARNING[type]}</span>
              </div>
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-600">
              {type === 'YOUTUBE'
                ? 'channelId (UC...) 或 youtube.com URL'
                : type === 'GITHUB'
                  ? t('radar.sourceList.identifierHint.github')
                  : type === 'HUGGING_FACE'
                    ? t('radar.sourceList.identifierHint.huggingFace')
                    : type === 'RSS'
                      ? 'RSS feed URL（公开免费，不要 paywall）'
                      : '列表页 URL（config.listSelector 在后台配）'}
            </label>
            <input
              type="text"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600">
              显示名（可选）
            </label>
            <input
              type="text"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div>
            <label
              className="block text-xs text-gray-600"
              htmlFor="source-authority-weight"
            >
              {t('radar.sourceList.authorityLabel')}
            </label>
            <select
              id="source-authority-weight"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400"
              value={authorityWeight}
              onChange={(e) => setAuthorityWeight(Number(e.target.value))}
            >
              {AUTHORITY_WEIGHT_VALUES.map((v) => (
                <option key={v} value={v}>
                  {t(`radar.sourceList.authorityOption.w${v}`)}
                </option>
              ))}
            </select>
          </div>
          {error && <ErrorInline message={error} className="text-xs" />}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            disabled={submitting}
            className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs text-white disabled:opacity-60"
            onClick={submit}
          >
            {submitting ? '添加中...' : '添加'}
          </button>
        </div>
      </div>
    </div>
  );
}

function BulkImportDialog({
  topicId,
  existing,
  onClose,
  onDone,
}: {
  topicId: string;
  existing: RadarSource[];
  onClose: () => void;
  onDone: (info: string) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { valid, duplicates, issues } = useMemo(
    () => parseSourceLines(text, existing, t),
    [text, existing, t]
  );
  const overLimit = valid.length > BULK_IMPORT_MAX;
  const hasCustom = valid.some((v) => v.type === 'CUSTOM');

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const result = await bulkCreateSources(
        topicId,
        valid.map((v) => ({
          type: v.type,
          identifier: v.identifier,
          label: v.label,
          authorityWeight: v.authorityWeight,
        }))
      );
      // 后端逐条降级的 skipped（shape 错 / preflight 不可达 / 已存在），
      // 文案范式与 AI 推荐入库保持一致
      if (result.skipped.length > 0) {
        const lines = result.skipped
          .slice(0, 5)
          .map((s) => `• ${s.type}:${s.identifier} - ${s.reason}`)
          .join('\n');
        const more =
          result.skipped.length > 5
            ? `\n• ${t('radar.sourceList.bulk.moreSkipped', {
                count: result.skipped.length - 5,
              })}`
            : '';
        onDone(
          `${t('radar.sourceList.bulk.doneWithSkipped', {
            created: result.created.length,
            skipped: result.skipped.length,
          })}\n${lines}${more}`
        );
      } else {
        onDone(
          t('radar.sourceList.bulk.done', { count: result.created.length })
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('radar.sourceList.bulk.title')}
      subtitle={t('radar.sourceList.bulk.subtitle')}
      size="lg"
      closeButtonDisabled={submitting}
      closeOnOverlayClick={!submitting}
      footer={
        <>
          <button
            type="button"
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600"
            disabled={submitting}
            onClick={onClose}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={submitting || valid.length === 0 || overLimit}
            className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs text-white disabled:opacity-60"
            onClick={() => void submit()}
          >
            {submitting
              ? t('radar.sourceList.bulk.submitting')
              : t('radar.sourceList.bulk.submit', { count: valid.length })}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Textarea
          rows={10}
          className="font-mono text-xs"
          aria-label={t('radar.sourceList.bulk.textareaLabel')}
          placeholder={t('radar.sourceList.bulk.placeholder')}
          value={text}
          error={issues.length > 0}
          disabled={submitting}
          onChange={(e) => setText(e.target.value)}
        />

        {valid.length > 0 && (
          <p className="text-xs text-emerald-700">
            {t('radar.sourceList.bulk.validCount', { count: valid.length })}
            {overLimit &&
              t('radar.sourceList.bulk.overLimit', { max: BULK_IMPORT_MAX })}
          </p>
        )}

        {duplicates.length > 0 && (
          <div className="text-xs text-gray-500">
            <p>
              {t('radar.sourceList.bulk.duplicateCount', {
                count: duplicates.length,
              })}
            </p>
            {duplicates.map((d) => (
              <p key={d.lineNo}>
                {t('radar.sourceList.bulk.duplicateLine', {
                  lineNo: d.lineNo,
                  reason: d.reason,
                })}
              </p>
            ))}
          </div>
        )}

        {issues.length > 0 && (
          <div className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-600">
            <p>
              {t('radar.sourceList.bulk.issueCount', { count: issues.length })}
            </p>
            {issues.map((it) => (
              <p key={it.lineNo}>
                {t('radar.sourceList.bulk.issueLine', {
                  lineNo: it.lineNo,
                  reason: it.reason,
                })}
              </p>
            ))}
          </div>
        )}

        {hasCustom && (
          <div className="flex items-start gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-1 text-xs text-amber-700">
            <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
            <span>{SOURCE_TYPE_WARNING.CUSTOM}</span>
          </div>
        )}

        {error && <ErrorInline message={error} className="text-xs" />}

        <p className="text-xs text-gray-400">
          {t('radar.sourceList.bulk.preflightNote', { max: BULK_IMPORT_MAX })}
        </p>
      </div>
    </Modal>
  );
}

function RecommendDialog({
  loading,
  candidates,
  selected,
  preflightInfo,
  onToggle,
  onClose,
  onAccept,
}: {
  loading: boolean;
  candidates: RecommendedSource[];
  selected: Set<number>;
  preflightInfo: { total: number; skipped: number } | null;
  onToggle: (i: number) => void;
  onClose: () => void;
  onAccept: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recommend-dialog-title"
    >
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl bg-white">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
          <h3
            id="recommend-dialog-title"
            className="text-sm font-semibold text-gray-900"
          >
            AI 推荐数据源（已勾选默认入库）
          </h3>
          <button
            type="button"
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100"
            onClick={onClose}
            aria-label="close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* R7 2026-05-19：preflight 阶段已过滤不可达源，告诉用户为什么数量这么少 */}
        {preflightInfo && (
          <div className="border-b border-emerald-100 bg-emerald-50/60 px-5 py-2 text-xs text-emerald-800">
            <Sparkles className="-mt-0.5 mr-1 inline-block h-3 w-3" />
            AI 生成 {preflightInfo.total} 个候选，系统已自动过滤{' '}
            {preflightInfo.skipped} 个不可达源（404 / 403 / 解析失败等）， 以下{' '}
            {candidates.length} 个均已验证可达。
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="py-12 text-center text-sm text-gray-400">
              AI 正在生成候选（含可达性预检，可能需要 10-30 秒）...
            </div>
          ) : candidates.length === 0 ? (
            <EmptyState
              size="sm"
              title="暂无候选源"
              description={
                preflightInfo && preflightInfo.skipped > 0
                  ? `AI 生成的 ${preflightInfo.total} 个候选全部不可达，请手动添加或换关键词重试。`
                  : 'AI 暂未找到合适的候选源，请手动添加。'
              }
            />
          ) : (
            <ul className="space-y-2">
              {candidates.map((c, i) => {
                const warning = SOURCE_TYPE_WARNING[c.type];
                return (
                  <li
                    key={`${c.type}-${c.identifier}`}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                      selected.has(i)
                        ? 'border-cyan-300 bg-cyan-50/50'
                        : 'border-gray-200'
                    }`}
                    onClick={() => onToggle(i)}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={selected.has(i)}
                      readOnly
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-600">
                          {SOURCE_TYPE_LABEL[c.type]}
                        </span>
                        <span className="text-xs font-medium text-gray-900">
                          {c.label}
                        </span>
                        <span className="text-xs text-gray-400">
                          confidence {c.confidence.toFixed(2)}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-gray-500">
                        {c.identifier}
                      </div>
                      {c.rationale && (
                        <div className="mt-0.5 text-xs text-gray-600">
                          {c.rationale}
                        </div>
                      )}
                      {warning && (
                        <div
                          className="mt-1.5 flex items-start gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-1 text-xs text-amber-700"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                          <span>{warning}</span>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button
            type="button"
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            disabled={loading || selected.size === 0}
            className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs text-white disabled:opacity-60"
            onClick={onAccept}
          >
            添加选中 ({selected.size})
          </button>
        </div>
      </div>
    </div>
  );
}
