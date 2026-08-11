import { describe, expect, it } from 'vitest';

import {
  INSIGHT_MIGRATION_MARKER,
  INSIGHT_MODULE_LIST,
  isDedicatedInsightTopic,
  resolveInsightModuleTopic,
} from '@/lib/constants/insight-modules';
import { NAV_GROUPS, navItemActive } from '@/lib/constants/nav-config';
import type { RadarTopicWithCounts } from '@/services/ai-radar/types';

function topic(
  name: string,
  description: string | null = null,
  id = name
): RadarTopicWithCounts {
  return {
    id,
    userId: 'user-1',
    visibility: 'PRIVATE',
    name,
    description,
    entityType: 'topic',
    keywords: [],
    matchMode: 'semantic',
    refreshCron: '0 */6 * * *',
    status: 'PAUSED',
    nextDueAt: null,
    lastRunAt: null,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    counts: { sources: 1, items: 1, runs: 0 },
  };
}

describe('independent insight modules', () => {
  it('exposes four distinct first-level navigation items', () => {
    const hrefs = INSIGHT_MODULE_LIST.map((module) => module.href);
    expect(hrefs).toEqual([
      '/insights/github',
      '/insights/hugging-face',
      '/insights/youtube',
      '/insights/creators',
    ]);
    expect(new Set(hrefs).size).toBe(4);

    const navItems = NAV_GROUPS.flatMap((group) => group.items).filter((item) =>
      item.href.startsWith('/insights/')
    );
    expect(navItems.map((item) => item.href)).toEqual(hrefs);
  });

  it('marks only the exact module route active', () => {
    const navItems = NAV_GROUPS.flatMap((group) => group.items).filter((item) =>
      item.href.startsWith('/insights/')
    );
    expect(
      navItems.map((item) => navItemActive('/insights/youtube', item))
    ).toEqual([false, false, true, false]);
  });

  it('resolves the marker-scoped topic instead of a same-name generic topic', () => {
    const generic = topic('GitHub 趋势', null, 'generic');
    const migrated = topic(
      'GitHub 趋势（Solar 历史）',
      `migration=${INSIGHT_MIGRATION_MARKER}`,
      'migrated'
    );
    expect(resolveInsightModuleTopic([generic, migrated], 'github')?.id).toBe(
      'migrated'
    );
  });

  it('identifies only dedicated module topics for removal from AI Radar', () => {
    expect(isDedicatedInsightTopic(topic('YouTube 洞察（Solar 历史）'))).toBe(
      true
    );
    expect(isDedicatedInsightTopic(topic('我的普通雷达主题'))).toBe(false);
  });
});
