import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RadarItem,
  RadarSource,
  RadarTopicWithCounts,
} from '@/services/ai-radar/types';

const mocks = vi.hoisted(() => ({
  listTopics: vi.fn(),
  listSources: vi.fn(),
  listFeed: vi.fn(),
}));

vi.mock('@/services/ai-radar/api', () => mocks);

import { InsightModulePage } from '../InsightModulePage';

const topic: RadarTopicWithCounts = {
  id: 'github-topic',
  userId: 'user-1',
  visibility: 'PRIVATE',
  name: 'GitHub 趋势（Solar 历史）',
  description: 'migration=solar-harness-insight-history-v1',
  entityType: 'topic',
  keywords: ['GitHub'],
  matchMode: 'semantic',
  refreshCron: '0 */6 * * *',
  status: 'PAUSED',
  nextDueAt: null,
  lastRunAt: null,
  createdAt: '2026-08-11T00:00:00.000Z',
  updatedAt: '2026-08-11T00:00:00.000Z',
  counts: { sources: 1, items: 10038, runs: 0 },
};

const source: RadarSource = {
  id: 'source-1',
  topicId: topic.id,
  type: 'GITHUB',
  identifier: 'trending',
  label: 'GitHub Trending',
  config: null,
  enabled: true,
  isAiRecommended: false,
  authorityWeight: 5,
  health: 'HEALTHY',
  consecutiveFailures: 0,
  cooldownUntil: null,
  lastFetchAt: '2026-08-10T00:00:00.000Z',
  lastError: null,
  createdAt: '2026-08-11T00:00:00.000Z',
  updatedAt: '2026-08-11T00:00:00.000Z',
};

const item: RadarItem = {
  id: 'item-1',
  topicId: topic.id,
  sourceId: source.id,
  externalId: 'owner/repo',
  contentHash: 'hash',
  title: 'owner/repo',
  content: 'An AI research repository',
  author: 'owner',
  authorAvatar: null,
  url: 'https://github.com/owner/repo',
  publishedAt: '2026-08-10T00:00:00.000Z',
  fetchedAt: '2026-08-11T00:00:00.000Z',
  relevanceScore: null,
  qualityScore: null,
  aiSummary: 'Repository insight summary',
  entities: null,
  metrics: { stars: 1234 },
  accepted: true,
  source: {
    id: source.id,
    type: source.type,
    label: source.label,
    identifier: source.identifier,
  },
};

describe('InsightModulePage', () => {
  beforeEach(() => {
    mocks.listTopics.mockReset();
    mocks.listSources.mockReset();
    mocks.listFeed.mockReset();
    mocks.listTopics.mockResolvedValue({ items: [topic], nextCursor: null });
    mocks.listSources.mockResolvedValue([source]);
    mocks.listFeed.mockResolvedValue({ items: [item], nextCursor: null });
  });

  it('renders an independent module header, stats and native data', async () => {
    render(<InsightModulePage moduleKey="github" />);

    expect(screen.getByText('GitHub 趋势')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('10,038')).toBeInTheDocument());
    expect(screen.getByText('owner/repo')).toBeInTheDocument();
    expect(screen.getByText('Repository insight summary')).toBeInTheDocument();
    expect(screen.getByText('GenesisPod 原生数据')).toBeInTheDocument();
    expect(mocks.listFeed).toHaveBeenCalledWith(
      topic.id,
      expect.objectContaining({ type: 'GITHUB', acceptedOnly: true })
    );
  });

  it('shows a module-specific empty state when the topic is absent', async () => {
    mocks.listTopics.mockResolvedValue({ items: [], nextCursor: null });
    render(<InsightModulePage moduleKey="youtube" />);

    await waitFor(() =>
      expect(screen.getByText('YouTube 洞察尚未初始化')).toBeInTheDocument()
    );
    expect(mocks.listSources).not.toHaveBeenCalled();
    expect(mocks.listFeed).not.toHaveBeenCalled();
  });
});
