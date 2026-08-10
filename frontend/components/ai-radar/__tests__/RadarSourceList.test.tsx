/// <reference types="@testing-library/jest-dom" />

/**
 * RadarSourceList 单元测试
 *
 * 覆盖（R2 5 路评审产出清单 — task #34）：
 *  - AddSourceForm 渲染原生 GITHUB / HUGGING_FACE / RSS / YOUTUBE / CUSTOM，X 永不出现
 *  - 选 CUSTOM 时显 amber warning（需配 listSelector）
 *  - 选 YOUTUBE / RSS / CUSTOM 时 identifier label 切换正确
 *  - 老 type=X 源仍能渲染（label 显示 "X (Twitter)"），不崩
 *  - hasLegacyX 时显示顶部黄条"X 已停止新推荐"提示
 *  - 没有 type=X 源时不显示黄条（避免误导）
 *  - 行内编辑 authorityWeight（读显示 / PATCH + 刷新 / 失败提示 / 同值不发请求）
 *  - 批量导入（多行解析后提交 / 错误行按行号提示 / 已存在的源跳过 / 后端 skipped 回显
 *    / 超长 identifier·显示名本地拦截 / 超过 20 条禁用提交）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import React from 'react';

vi.mock('@/services/ai-radar/api', () => ({
  acceptRecommendedSources: vi.fn(),
  bulkCreateSources: vi.fn(),
  createSource: vi.fn(),
  deleteSource: vi.fn(),
  recommendSources: vi.fn(),
  updateSource: vi.fn(),
}));

import { RadarSourceList } from '../RadarSourceList';
import { bulkCreateSources, updateSource } from '@/services/ai-radar/api';
import type { RadarSource } from '@/services/ai-radar/types';

function makeSource(overrides: Partial<RadarSource> = {}): RadarSource {
  return {
    id: 'src-1',
    topicId: 'tid-1',
    type: 'RSS',
    identifier: 'https://openai.com/blog/rss.xml',
    label: 'OpenAI Blog',
    config: null,
    enabled: true,
    isAiRecommended: false,
    authorityWeight: 3,
    health: 'HEALTHY',
    consecutiveFailures: 0,
    cooldownUntil: null,
    lastFetchAt: '2026-05-15T10:00:00Z',
    lastError: null,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-15T10:00:00Z',
    ...overrides,
  };
}

describe('RadarSourceList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('legacy X notice banner', () => {
    it('显示顶部黄条 when sources contain type=X', () => {
      const sources = [
        makeSource({ id: 's1', type: 'RSS' }),
        makeSource({ id: 's2', type: 'X', identifier: '@elonmusk' }),
      ];
      render(
        <RadarSourceList
          topicId="tid-1"
          sources={sources}
          onReload={() => {}}
        />
      );
      const status = screen.getByRole('status');
      expect(status.textContent).toMatch(/X \(Twitter\) 已停止新推荐/);
      expect(status.textContent).toMatch(/Nitter/);
    });

    it('不显示黄条 when sources 不含 type=X', () => {
      const sources = [
        makeSource({ id: 's1', type: 'RSS' }),
        makeSource({ id: 's2', type: 'YOUTUBE', identifier: 'UC-abc' }),
      ];
      render(
        <RadarSourceList
          topicId="tid-1"
          sources={sources}
          onReload={() => {}}
        />
      );
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('老 type=X 源仍正常渲染 label "X (Twitter)" 不崩', () => {
      const sources = [
        makeSource({ id: 'x1', type: 'X', identifier: '@cnbc', label: 'CNBC' }),
      ];
      render(
        <RadarSourceList
          topicId="tid-1"
          sources={sources}
          onReload={() => {}}
        />
      );
      expect(screen.getByText('X (Twitter)')).toBeInTheDocument();
      expect(screen.getByText('CNBC')).toBeInTheDocument();
    });
  });

  describe('AddSourceForm 类型按钮', () => {
    function openAddForm() {
      render(
        <RadarSourceList topicId="tid-1" sources={[]} onReload={() => {}} />
      );
      fireEvent.click(screen.getByRole('button', { name: /添加/ }));
      return screen.getByRole('dialog');
    }

    it('渲染五种原生可添加来源，X 永不出现', () => {
      const dialog = openAddForm();
      const scoped = within(dialog);
      expect(scoped.getByRole('button', { name: 'RSS' })).toBeInTheDocument();
      expect(
        scoped.getByRole('button', { name: 'YouTube' })
      ).toBeInTheDocument();
      expect(
        scoped.getByRole('button', { name: '自定义' })
      ).toBeInTheDocument();
      expect(
        scoped.getByRole('button', { name: 'GitHub' })
      ).toBeInTheDocument();
      expect(
        scoped.getByRole('button', { name: 'Hugging Face' })
      ).toBeInTheDocument();
      expect(
        scoped.queryByRole('button', { name: /X \(Twitter\)/ })
      ).not.toBeInTheDocument();
    });

    it('默认选 RSS，identifier label 显示 RSS 提示', () => {
      const dialog = openAddForm();
      expect(
        within(dialog).getByText(/RSS feed URL.+不要 paywall/)
      ).toBeInTheDocument();
    });

    it('选 YouTube 切换 identifier label 到 channelId 提示', () => {
      const dialog = openAddForm();
      fireEvent.click(within(dialog).getByRole('button', { name: 'YouTube' }));
      expect(
        within(dialog).getByText(/channelId \(UC\.\.\.\) 或 youtube\.com URL/)
      ).toBeInTheDocument();
    });

    it('GitHub / Hugging Face 显示 typed identifier 契约', () => {
      const dialog = openAddForm();
      const scoped = within(dialog);
      fireEvent.click(scoped.getByRole('button', { name: 'GitHub' }));
      expect(scoped.getByText(/trending、owner\/repo/)).toBeInTheDocument();
      fireEvent.click(scoped.getByRole('button', { name: 'Hugging Face' }));
      expect(
        scoped.getByText(/models、papers、models:<query>/)
      ).toBeInTheDocument();
    });

    it('选 自定义 显 amber warning 提示需配 listSelector', () => {
      const dialog = openAddForm();
      fireEvent.click(within(dialog).getByRole('button', { name: '自定义' }));
      expect(
        within(dialog).getByText(/config\.listSelector 提供 CSS 选择器/)
      ).toBeInTheDocument();
    });

    it('选 RSS 不显 amber warning（RSS 无需额外 config）', () => {
      const dialog = openAddForm();
      expect(
        within(dialog).queryByText(/listSelector/)
      ).not.toBeInTheDocument();
    });
  });

  describe('行内权威度编辑', () => {
    // 一行一个 select，用 accessible name（含 label）区分，禁止裸查 combobox
    function weightSelect(name: RegExp = /信源权威度/) {
      return screen.getByRole('combobox', { name });
    }

    it('渲染当前 authorityWeight 值', () => {
      render(
        <RadarSourceList
          topicId="tid-1"
          sources={[makeSource({ authorityWeight: 4 })]}
          onReload={() => {}}
        />
      );
      expect((weightSelect() as HTMLSelectElement).value).toBe('4');
    });

    it('改星级 → updateSource PATCH + onReload', async () => {
      const onReload = vi.fn();
      vi.mocked(updateSource).mockResolvedValueOnce(makeSource());
      render(
        <RadarSourceList
          topicId="tid-1"
          sources={[makeSource()]}
          onReload={onReload}
        />
      );
      fireEvent.change(weightSelect(), { target: { value: '5' } });
      await waitFor(() => {
        expect(updateSource).toHaveBeenCalledTimes(1);
      });
      expect(updateSource).toHaveBeenCalledWith('src-1', {
        authorityWeight: 5,
      });
      expect(onReload).toHaveBeenCalled();
    });

    it('updateSource 失败时显示「权威度更新失败」', async () => {
      vi.mocked(updateSource).mockRejectedValueOnce(new Error('boom'));
      render(
        <RadarSourceList
          topicId="tid-1"
          sources={[makeSource()]}
          onReload={() => {}}
        />
      );
      fireEvent.change(weightSelect(), { target: { value: '1' } });
      await waitFor(() => {
        expect(screen.getByText(/权威度更新失败：boom/)).toBeInTheDocument();
      });
    });

    it('选中与当前相同的星级不发请求', () => {
      render(
        <RadarSourceList
          topicId="tid-1"
          sources={[makeSource({ authorityWeight: 3 })]}
          onReload={() => {}}
        />
      );
      fireEvent.change(weightSelect(), { target: { value: '3' } });
      expect(updateSource).not.toHaveBeenCalled();
    });
  });

  describe('批量导入', () => {
    function openBulkDialog(sources: RadarSource[] = [], onReload = () => {}) {
      render(
        <RadarSourceList
          topicId="tid-1"
          sources={sources}
          onReload={onReload}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /批量导入/ }));
      return screen.getByLabelText('批量导入文本');
    }

    it('粘贴多行 → 解析计数正确 → 提交时按行透传 type/identifier/label/权威度', async () => {
      const onReload = vi.fn();
      vi.mocked(bulkCreateSources).mockResolvedValueOnce({
        created: [makeSource({ id: 'new-1' }), makeSource({ id: 'new-2' })],
        skipped: [],
      });
      const textarea = openBulkDialog([], onReload);
      fireEvent.change(textarea, {
        target: {
          value: [
            '# 注释行会被忽略',
            '',
            'RSS | https://openai.com/blog/rss.xml | OpenAI 官博 | 5',
            'youtube | UCXuqSBlHAE6Xw-yeJA0Tunw',
          ].join('\n'),
        },
      });

      expect(screen.getByText('可导入 2 条')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '导入 2 条' }));

      await waitFor(() => {
        expect(bulkCreateSources).toHaveBeenCalledTimes(1);
      });
      expect(bulkCreateSources).toHaveBeenCalledWith('tid-1', [
        {
          type: 'RSS',
          identifier: 'https://openai.com/blog/rss.xml',
          label: 'OpenAI 官博',
          authorityWeight: 5,
        },
        {
          type: 'YOUTUBE',
          identifier: 'UCXuqSBlHAE6Xw-yeJA0Tunw',
          label: undefined,
          authorityWeight: undefined,
        },
      ]);
      await waitFor(() => {
        expect(screen.getByText(/已导入 2 个数据源/)).toBeInTheDocument();
      });
      expect(onReload).toHaveBeenCalled();
    });

    it('identifier 里的 query string 不被切断（只按 | 分列）', () => {
      const textarea = openBulkDialog();
      fireEvent.change(textarea, {
        target: { value: 'RSS | https://a.com/feed?key=abc&x=1,2 | 付费源' },
      });
      expect(screen.getByText('可导入 1 条')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: '导入 1 条' })
      ).not.toBeDisabled();
    });

    it('格式错误行给出带行号的原因，且不阻塞其余可导入行', () => {
      const textarea = openBulkDialog();
      fireEvent.change(textarea, {
        target: {
          value: [
            'RSS | https://ok.com/feed',
            'twitter | @elonmusk',
            'RSS | 不是链接',
            'YOUTUBE | UCXuqSBlHAE6Xw-yeJA0Tunw | LTT | 9',
          ].join('\n'),
        },
      });

      expect(screen.getByText('3 行无法解析：')).toBeInTheDocument();
      expect(
        screen.getByText(/第 2 行：未知类型「twitter」，仅支持 RSS/)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/第 3 行：RSS 的 identifier 必须是 http\(s\) 链接/)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/第 4 行：权威度必须是 1-5 的整数，实际「9」/)
      ).toBeInTheDocument();
      // 其余行仍可导入
      expect(screen.getByText('可导入 1 条')).toBeInTheDocument();
    });

    it('与已有源重复的行标为「已存在」并排除出提交列表', () => {
      const textarea = openBulkDialog([
        makeSource({ type: 'RSS', identifier: 'https://dup.com/feed' }),
      ]);
      fireEvent.change(textarea, {
        target: {
          value: [
            'RSS | https://dup.com/feed',
            'RSS | https://new.com/feed',
          ].join('\n'),
        },
      });
      expect(screen.getByText('跳过 1 条（已存在）：')).toBeInTheDocument();
      expect(
        screen.getByText(/第 1 行 RSS:https:\/\/dup\.com\/feed/)
      ).toBeInTheDocument();
      expect(screen.getByText('可导入 1 条')).toBeInTheDocument();
    });

    it('后端逐条 skipped 回显到结果条带', async () => {
      vi.mocked(bulkCreateSources).mockResolvedValueOnce({
        created: [makeSource({ id: 'new-1' })],
        skipped: [
          {
            type: 'RSS',
            identifier: 'https://dead.com/feed',
            reason: '404 Not Found',
          },
        ],
      });
      const textarea = openBulkDialog();
      fireEvent.change(textarea, {
        target: {
          value: [
            'RSS | https://ok.com/feed',
            'RSS | https://dead.com/feed',
          ].join('\n'),
        },
      });
      fireEvent.click(screen.getByRole('button', { name: '导入 2 条' }));

      await waitFor(() => {
        expect(
          screen.getByText(/已导入 1 个源，跳过 1 个：/)
        ).toBeInTheDocument();
      });
      expect(
        screen.getByText(/RSS:https:\/\/dead\.com\/feed - 404 Not Found/)
      ).toBeInTheDocument();
    });

    it('超长 identifier / 显示名按后端 MaxLength 本地拦截', () => {
      const textarea = openBulkDialog();
      fireEvent.change(textarea, {
        target: {
          value: [
            `RSS | https://a.com/${'x'.repeat(500)}`,
            `RSS | https://b.com/feed | ${'名'.repeat(201)}`,
          ].join('\n'),
        },
      });
      expect(screen.getByText('2 行无法解析：')).toBeInTheDocument();
      expect(
        screen.getByText(/第 1 行：identifier 超过 500 字符/)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/第 2 行：显示名超过 200 字符/)
      ).toBeInTheDocument();
      expect(screen.queryByText(/可导入/)).not.toBeInTheDocument();
    });

    it('超过 20 条时禁用提交并提示分批（后端 @ArrayMaxSize(20) 是整批 400）', () => {
      const textarea = openBulkDialog();
      fireEvent.change(textarea, {
        target: {
          value: Array.from(
            { length: 21 },
            (_, i) => `RSS | https://a${i}.com/feed`
          ).join('\n'),
        },
      });
      expect(
        screen.getByText(/一次最多 20 条，请分批粘贴/)
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '导入 21 条' })).toBeDisabled();
      expect(bulkCreateSources).not.toHaveBeenCalled();
    });

    it('导入失败时在弹层内提示，不关闭弹层', async () => {
      vi.mocked(bulkCreateSources).mockRejectedValueOnce(new Error('boom'));
      const textarea = openBulkDialog();
      fireEvent.change(textarea, {
        target: { value: 'RSS | https://ok.com/feed' },
      });
      fireEvent.click(screen.getByRole('button', { name: '导入 1 条' }));

      await waitFor(() => {
        expect(screen.getByText('boom')).toBeInTheDocument();
      });
      expect(screen.getByLabelText('批量导入文本')).toBeInTheDocument();
    });
  });
});
