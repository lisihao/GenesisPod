/**
 * 主导航单一数据源（IA SSOT）。
 *
 * 桌面 Sidebar 与移动 MobileNav 都从这里渲染，杜绝两套手抄导航漂移。
 * 这里只描述「主内容导航」（分组 + 条目）；账号/通知/系统等底部分区各自保留。
 *
 * 改菜单 = 只改这一个文件。两端同步生效。
 */

import {
  Lightbulb,
  Telescope,
  Store,
  BookOpen,
  Radar,
  Eye,
  Compass,
  Users,
  ClipboardList,
  LayoutGrid,
  PieChart,
  PenLine,
  Share2,
  Github,
  Bot,
  Youtube,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import type { ModuleKey } from '@/lib/design/module-themes';
import { INSIGHT_MODULES } from '@/lib/constants/insight-modules';

export interface NavItem {
  href: string;
  /** i18n key（t(labelKey)）；与 label 二选一 */
  labelKey?: string;
  /** 字面标签（无 i18n key 时用，如 我的英雄 / 我的任务） */
  label?: string;
  Icon: LucideIcon;
  /** 命中方式：true=startsWith 前缀；缺省=精确 === */
  matchPrefix?: boolean;
  /** 模块识别色（active 态用 MODULE_THEMES[moduleKey]）；缺省=中性灰 */
  moduleKey?: ModuleKey;
  /** 仅管理员可见 */
  adminOnly?: boolean;
  /** 点击已在当前页时强制硬刷新（部分入口的既有行为） */
  forceReload?: boolean;
}

export interface NavGroup {
  /** 分组标题 i18n key（与 label 二选一）；都没有=无标题分组（顶部 AI 问答） */
  labelKey?: string;
  label?: string;
  /** 暂时隐藏（保留数据，一处开关即可恢复） */
  hidden?: boolean;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  // 顶部：AI 问答（无分组标题）
  {
    items: [
      {
        href: '/ai-ask',
        labelKey: 'nav.aiAsk',
        Icon: Lightbulb,
        moduleKey: 'ask',
        matchPrefix: true,
        forceReload: true,
      },
    ],
  },
  // 我的工作台：信源库（前沿信息感知）/ 知识库 / 专家团（专家花名册 + 专家任务双 Tab）
  {
    labelKey: 'nav.sections.myWorkspace',
    items: [
      {
        href: '/explore',
        labelKey: 'nav.myExplore',
        Icon: Telescope,
        moduleKey: 'explore',
        forceReload: true,
      },
      {
        href: '/library',
        labelKey: 'nav.myLibrary',
        Icon: BookOpen,
        moduleKey: 'library',
        forceReload: true,
      },
      {
        href: '/agents',
        labelKey: 'nav.myExperts',
        Icon: Users,
        matchPrefix: true,
      },
    ],
  },
  // 独立洞察频道：四类迁移能力拥有自己的一级入口和页面，不再寄生在 AI Radar。
  {
    labelKey: 'nav.sections.insightChannels',
    items: [
      {
        href: INSIGHT_MODULES.github.href,
        labelKey: INSIGHT_MODULES.github.navLabelKey,
        Icon: Github,
        moduleKey: 'radar',
      },
      {
        href: INSIGHT_MODULES.huggingFace.href,
        labelKey: INSIGHT_MODULES.huggingFace.navLabelKey,
        Icon: Bot,
        moduleKey: 'radar',
      },
      {
        href: INSIGHT_MODULES.youtube.href,
        labelKey: INSIGHT_MODULES.youtube.navLabelKey,
        Icon: Youtube,
        moduleKey: 'radar',
      },
      {
        href: INSIGHT_MODULES.creators.href,
        labelKey: INSIGHT_MODULES.creators.navLabelKey,
        Icon: UsersRound,
        moduleKey: 'radar',
      },
    ],
  },
  // 深度洞察：雷达（信号流）→ 洞察（深度生成）→ 前瞻（判断资产）
  // 2026-06-12 IA 重构：
  //   - 「AI 洞察」菜单改指 agent-playground（多 Agent mission 全面替代 Topic Insights），
  //     原 /ai-insights 路由与数据保活，仅摘菜单（书签/历史链接可直达）
  //   - 「AI 研究」菜单位由「AI 前瞻」（判断资产/假设图谱）替换，
  //     原 /ai-research 路由保活，研究能力后续收进前瞻/洞察内部作为动作
  //   - 「AI 实验场」独立入口移除（已升级为 AI 洞察正式入口）
  {
    labelKey: 'nav.sections.researchAnalysis',
    items: [
      {
        href: '/ai-radar',
        labelKey: 'nav.aiRadar',
        Icon: Radar,
        moduleKey: 'radar',
        matchPrefix: true,
      },
      {
        href: '/agent-playground',
        labelKey: 'nav.aiInsights',
        Icon: Eye,
        moduleKey: 'insights',
        matchPrefix: true,
      },
      {
        href: '/foresight',
        labelKey: 'nav.aiForesight',
        Icon: Compass,
        moduleKey: 'research',
        matchPrefix: true,
      },
    ],
  },
  // 发现更多（原「AI 广场」，置底）：去专家市场招募
  {
    labelKey: 'nav.sections.discoverMore',
    items: [
      {
        href: '/marketplace',
        labelKey: 'nav.expertMarket',
        Icon: Store,
        moduleKey: 'market',
        matchPrefix: true,
      },
    ],
  },
  // 推演决策（暂时隐藏，数据保留）
  {
    labelKey: 'nav.sections.planningDecision',
    hidden: true,
    items: [
      {
        href: '/ai-teams',
        labelKey: 'nav.myTeams',
        Icon: Users,
        moduleKey: 'discuss',
        matchPrefix: true,
      },
      {
        href: '/ai-planning',
        labelKey: 'nav.aiPlanning',
        Icon: ClipboardList,
        moduleKey: 'planning',
        matchPrefix: true,
      },
      {
        href: '/ai-simulation',
        labelKey: 'nav.aiSimulation',
        Icon: LayoutGrid,
        moduleKey: 'decision',
        matchPrefix: true,
      },
    ],
  },
  // 内容工坊（暂时隐藏，数据保留）
  {
    labelKey: 'nav.sections.creativeWriting',
    hidden: true,
    items: [
      {
        href: '/ai-office',
        labelKey: 'nav.aiReports',
        Icon: PieChart,
        moduleKey: 'report',
        matchPrefix: true,
        forceReload: true,
      },
      {
        href: '/ai-writing',
        labelKey: 'nav.aiWriting',
        Icon: PenLine,
        moduleKey: 'writing',
        matchPrefix: true,
      },
      {
        href: '/ai-social',
        labelKey: 'nav.aiSocial',
        Icon: Share2,
        moduleKey: 'social',
        matchPrefix: true,
        adminOnly: true,
      },
    ],
  },
];

/** 条目是否命中当前路由。 */
export function navItemActive(
  pathname: string | null | undefined,
  item: NavItem
): boolean {
  if (!pathname) return false;
  return item.matchPrefix
    ? pathname.startsWith(item.href)
    : pathname === item.href;
}
