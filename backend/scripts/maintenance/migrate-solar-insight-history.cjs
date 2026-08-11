#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MARKER = "solar-harness-insight-history-v1";
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_SOURCE_DB =
  "/Users/lisihao/.solar/harness/state/tech-hotspot-radar/tech-hotspot-radar.sqlite";

const TOPICS = {
  github: {
    name: "GitHub 趋势（Solar 历史）",
    entityType: "topic",
    keywords: ["GitHub", "AI", "开源", "趋势"],
  },
  huggingFace: {
    name: "Hugging Face 论文（Solar 历史）",
    entityType: "topic",
    keywords: ["Hugging Face", "AI", "论文", "模型"],
  },
  youtube: {
    name: "YouTube 洞察（Solar 历史）",
    entityType: "topic",
    keywords: ["YouTube", "AI", "技术", "视频"],
  },
  creators: {
    name: "大咖洞察（Solar 历史）",
    entityType: "person",
    keywords: ["AI", "大咖", "观点", "人物"],
  },
};

function parseArgs(argv) {
  const args = {
    mode: "dry-run",
    sourceDb: DEFAULT_SOURCE_DB,
    ownerUserId: "",
    envPath: path.resolve(process.cwd(), ".env"),
    reportDir: path.resolve(process.cwd(), "exports", MARKER),
    batchSize: DEFAULT_BATCH_SIZE,
    confirmRollback: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--self-test") args.mode = "self-test";
    else if (value === "--mode") args.mode = argv[++index];
    else if (value === "--source-db") args.sourceDb = argv[++index];
    else if (value === "--owner-user-id") args.ownerUserId = argv[++index];
    else if (value === "--env") args.envPath = argv[++index];
    else if (value === "--report-dir") args.reportDir = argv[++index];
    else if (value === "--batch-size") args.batchSize = Number(argv[++index]);
    else if (value === "--confirm-rollback")
      args.confirmRollback = argv[++index];
    else if (value === "--help" || value === "-h") args.mode = "help";
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!["self-test", "help"].includes(args.mode)) {
    if (!fs.existsSync(args.sourceDb)) {
      throw new Error(`Source database not found: ${args.sourceDb}`);
    }
    if (!Number.isInteger(args.batchSize) || args.batchSize < 1 || args.batchSize > 500) {
      throw new Error("--batch-size must be an integer in [1, 500]");
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node migrate-solar-insight-history.cjs --mode dry-run [options]
  node migrate-solar-insight-history.cjs --mode execute --owner-user-id UUID [options]
  node migrate-solar-insight-history.cjs --mode verify --owner-user-id UUID [options]
  node migrate-solar-insight-history.cjs --mode rollback --owner-user-id UUID \\
    --confirm-rollback ${MARKER} [options]

Options:
  --source-db PATH
  --env PATH
  --report-dir PATH
  --batch-size N
  --self-test

The source SQLite database is always opened with sqlite3 -readonly.`);
}

function normalizeLegacyTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value
    .trim()
    .replace(/:(\d{2})(\d{4})Z$/, ":$1.$2Z");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function firstValidDate(...values) {
  for (const value of values) {
    const parsed = normalizeLegacyTimestamp(value);
    if (parsed) return parsed;
  }
  return null;
}

function safeJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sanitizeLegacyString(value) {
  const input = String(value);
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 0) {
      output += "\uFFFD";
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += input[index] + input[index + 1];
        index += 1;
      } else {
        output += "\uFFFD";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      output += "\uFFFD";
      continue;
    }
    output += input[index];
  }
  return output;
}

function truncate(value, limit) {
  if (value === null || value === undefined) return null;
  return sanitizeLegacyString(value).slice(0, limit);
}

function computeContentHash(title, content) {
  const normalize = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const normalizedTitle = normalize(title);
  const normalizedContent = normalize(content).slice(0, 1000);
  return crypto
    .createHash("sha256")
    .update(`${normalizedTitle}|${normalizedContent}`)
    .digest("hex");
}

function cleanJson(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeLegacyString(value);
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((entry) => cleanJson(entry));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cleanJson(entry)]),
    );
  }
  return value;
}

function sqliteJson(sourceDb, sql) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = spawnSync(
      "/usr/bin/sqlite3",
      ["-readonly", "-json", sourceDb, sql],
      {
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    if (result.status === 0) {
      const output = result.stdout.trim();
      return output ? JSON.parse(output) : [];
    }
    lastError = new Error(
      `sqlite3 failed attempt=${attempt}: ${(result.stderr || result.error || "unknown").toString().trim()}`,
    );
    if (!String(lastError.message).includes("locked")) break;
  }
  throw lastError;
}

function sqliteScalar(sourceDb, sql) {
  const rows = sqliteJson(sourceDb, sql);
  if (!rows.length) return 0;
  return Number(Object.values(rows[0])[0] || 0);
}

function sourceStats(sourceDb) {
  return {
    github: sqliteScalar(sourceDb, "SELECT count(*) AS n FROM github_repos"),
    huggingFace: sqliteScalar(
      sourceDb,
      "SELECT count(*) AS n FROM (SELECT paper_id FROM hf_daily_papers UNION SELECT paper_id FROM hf_trending_papers)",
    ),
    youtube: sqliteScalar(sourceDb, "SELECT count(*) AS n FROM youtube_videos"),
    creators: sqliteScalar(sourceDb, "SELECT count(*) AS n FROM social_posts"),
    youtubeChannels: sqliteScalar(
      sourceDb,
      "SELECT count(*) AS n FROM youtube_channels",
    ),
    creatorAccounts: sqliteScalar(
      sourceDb,
      "SELECT count(*) AS n FROM social_accounts",
    ),
    acceptedTranscripts: sqliteScalar(
      sourceDb,
      "SELECT count(*) AS n FROM youtube_transcripts WHERE transcript_status='fetched' AND length(transcript_clean)>=200",
    ),
    creatorViewpoints: sqliteScalar(
      sourceDb,
      "SELECT count(*) AS n FROM big_name_viewpoints",
    ),
  };
}

function sourceQuickCheck(sourceDb) {
  const rows = sqliteJson(sourceDb, "PRAGMA quick_check");
  const messages = rows.map((row) => String(Object.values(row)[0]));
  return { ok: messages.length === 1 && messages[0] === "ok", messages };
}

function githubBatch(sourceDb, limit, offset) {
  return sqliteJson(
    sourceDb,
    `SELECT
       g.*,
       COALESCE((
         SELECT json_group_array(json_object(
           'snapshotAt', s.snapshot_at,
           'stars', s.stars,
           'forks', s.forks,
           'openIssues', s.open_issues,
           'watchers', s.watchers,
           'starsDelta1d', s.stars_delta_1d,
           'starsDelta7d', s.stars_delta_7d,
           'starsDelta30d', s.stars_delta_30d,
           'starsDelta1h', s.stars_delta_1h,
           'starsDelta6h', s.stars_delta_6h,
           'starsDelta24h', s.stars_delta_24h,
           'starAcceleration', s.star_acceleration,
           'historyStatus', s.history_status
         )) FROM github_star_snapshots s WHERE s.full_name=g.full_name
       ), '[]') AS history_json,
       COALESCE((
         SELECT json_object(
           'cardId', c.card_id,
           'positioning', c.positioning,
           'whatItDoes', c.what_it_does,
           'targetUsers', c.target_users,
           'coreTechnicalIdea', c.core_technical_idea,
           'whyHotFacts', json(c.why_hot_facts),
           'scores', json(c.scores_json),
           'trendImplication', c.trend_implication,
           'risks', json(c.risks_json),
           'watchNext', json(c.watch_next),
           'tier', c.tier,
           'confidence', c.confidence,
           'modelUsed', c.model_used,
           'updatedAt', c.updated_at
         ) FROM repo_analysis_cards c
         WHERE c.repo_full_name=g.full_name
         ORDER BY c.updated_at DESC LIMIT 1
       ), '{}') AS card_json,
       COALESCE((
         SELECT json_group_array(json_object(
           'atomId', e.atom_id,
           'type', e.evidence_type,
           'content', e.compressed_content,
           'entities', json(e.entities_json),
           'tags', json(e.tags_json),
           'confidence', e.confidence,
           'technicalDepth', e.technical_depth,
           'noveltyScore', e.novelty_score,
           'sourceType', e.raw_source_type,
           'sourceId', e.raw_source_id,
           'createdAt', e.created_at
         )) FROM repo_evidence_atoms e WHERE e.repo_full_name=g.full_name
       ), '[]') AS evidence_json
     FROM github_repos g
     ORDER BY g.full_name
     LIMIT ${limit} OFFSET ${offset}`,
  );
}

function huggingFaceBatch(sourceDb, limit, offset) {
  return sqliteJson(
    sourceDb,
    `WITH combined AS (
       SELECT paper_id,title,hf_url,arxiv_url,summary,authors,rank,'' AS score_text,
              topic_tags,first_seen_at,last_seen_at,fetched_at,raw_json,
              paper_date AS published_hint,'daily' AS source_kind
       FROM hf_daily_papers
       UNION ALL
       SELECT paper_id,title,hf_url,arxiv_url,summary,authors,rank,score_text,
              topic_tags,first_seen_at,last_seen_at,fetched_at,raw_json,
              substr(first_seen_at,1,10) AS published_hint,'trending' AS source_kind
       FROM hf_trending_papers
     ), ranked AS (
       SELECT *, row_number() OVER (
         PARTITION BY paper_id ORDER BY last_seen_at DESC, source_kind ASC
       ) AS rn
       FROM combined
     )
     SELECT
       r.*,
       COALESCE((
         SELECT json_group_array(json_object(
           'paperDate', d.paper_date,
           'snapshotAt', d.snapshot_at,
           'rank', d.rank,
           'title', d.title,
           'kind', 'daily'
         )) FROM hf_daily_paper_snapshots d WHERE d.paper_id=r.paper_id
       ), '[]') AS daily_history_json,
       COALESCE((
         SELECT json_group_array(json_object(
           'snapshotAt', s.snapshot_at,
           'rank', s.rank,
           'scoreText', s.score_text,
           'title', s.title,
           'kind', 'trending'
         )) FROM hf_paper_snapshots s WHERE s.paper_id=r.paper_id
       ), '[]') AS trending_history_json,
       COALESCE((
         SELECT json_group_array(json_object(
           'period', p.period,
           'snapshotAt', p.snapshot_at,
           'rank', p.rank,
           'scoreText', p.score_text,
           'title', p.title
         )) FROM hf_paper_period_snapshots p WHERE p.paper_id=r.paper_id
       ), '[]') AS period_history_json
     FROM ranked r
     WHERE r.rn=1
     ORDER BY r.paper_id
     LIMIT ${limit} OFFSET ${offset}`,
  );
}

function youtubeBatch(sourceDb, limit, offset) {
  return sqliteJson(
    sourceDb,
    `SELECT
       v.*,
       t.transcript_clean,
       t.transcript_status,
       t.source AS transcript_source,
       t.language AS transcript_language,
       t.fetched_at AS transcript_fetched_at,
       t.char_count AS transcript_char_count,
       t.is_auto_generated,
       t.model AS transcript_model,
       t.model_version AS transcript_model_version,
       t.transcript_hash,
       t.quality_score,
       t.quality_tier,
       t.coverage_ratio,
       t.hallucination_risk,
       COALESCE((
         SELECT json_group_array(json_object(
           'snapshotAt', s.snapshot_at,
           'views', s.view_count,
           'likes', s.like_count,
           'comments', s.comment_count
         )) FROM youtube_video_snapshots s WHERE s.video_id=v.video_id
       ), '[]') AS history_json
     FROM youtube_videos v
     LEFT JOIN youtube_transcripts t ON t.video_id=v.video_id
     ORDER BY v.video_id
     LIMIT ${limit} OFFSET ${offset}`,
  );
}

function creatorBatch(sourceDb, limit, offset) {
  return sqliteJson(
    sourceDb,
    `SELECT
       p.*,
       a.display_name,
       a.platform,
       a.weight AS author_weight,
       COALESCE((
         SELECT json_object(
           'viewpointId', v.viewpoint_id,
           'targetTopic', v.target_topic,
           'targetEntity', v.target_entity,
           'viewpoint', v.viewpoint,
           'stance', v.stance,
           'timeHorizon', v.time_horizon,
           'claimType', v.claim_type,
           'strength', v.strength,
           'confidence', v.confidence,
           'implications', json(v.implications_json),
           'relatedEntities', json(v.related_entities_json),
           'createdAt', v.created_at
         ) FROM big_name_viewpoints v WHERE v.post_id=p.post_id
         ORDER BY v.created_at DESC LIMIT 1
       ), '{}') AS viewpoint_json,
       COALESCE((
         SELECT json_group_array(json_object(
           'snapshotAt', s.snapshot_at,
           'replies', s.reply_count,
           'reposts', s.repost_count,
           'likes', s.like_count,
           'views', s.view_count,
           'engagementDelta1h', s.engagement_delta_1h,
           'engagementDelta6h', s.engagement_delta_6h,
           'engagementDelta24h', s.engagement_delta_24h,
           'velocityScore', s.velocity_score
         )) FROM social_post_snapshots s WHERE s.post_id=p.post_id
       ), '[]') AS history_json
     FROM social_posts p
     JOIN social_accounts a ON a.handle=p.author_handle
     ORDER BY p.post_id
     LIMIT ${limit} OFFSET ${offset}`,
  );
}

function githubItem(row, topicId, sourceId) {
  const content = [row.description, row.readme_text]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const publishedAt = firstValidDate(
    row.pushed_at,
    row.updated_at,
    row.created_at,
    row.fetched_at,
  );
  const fetchedAt = firstValidDate(row.fetched_at, row.updated_at, row.created_at);
  if (!publishedAt || !fetchedAt) return null;
  const card = safeJson(row.card_json, {});
  const summary = [card.positioning, card.whatItDoes, card.trendImplication]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n\n");
  return {
    topicId,
    sourceId,
    externalId: String(row.full_name),
    contentHash: computeContentHash(row.full_name, content),
    title: String(row.full_name),
    content: content || null,
    author: truncate(row.owner, 200),
    authorAvatar: null,
    url: truncate(row.html_url, 1000),
    publishedAt,
    fetchedAt,
    raw: cleanJson({
      provider: "github",
      evidence: {
        externalId: row.full_name,
        url: row.html_url,
        observedAt: fetchedAt.toISOString(),
      },
      repository: {
        repoId: row.repo_id,
        fullName: row.full_name,
        description: row.description,
        topics: safeJson(row.topics, row.topics || []),
        language: row.language,
        license: row.license,
        stars: row.stars,
        forks: row.forks,
        watchers: row.watchers,
        openIssues: row.open_issues,
        defaultBranch: row.default_branch,
        archived: Boolean(row.archived),
        latestReleaseTag: row.latest_release_tag,
        latestReleaseAt: row.latest_release_at,
      },
      migration: { marker: MARKER, source: "solar-harness" },
      legacy: {
        metricHistory: safeJson(row.history_json, []),
        analysisCard: card,
        evidenceAtoms: safeJson(row.evidence_json, []),
      },
    }),
    metrics: cleanJson({
      stars: Number(row.stars || 0),
      forks: Number(row.forks || 0),
      openIssues: Number(row.open_issues || 0),
      watchers: Number(row.watchers || 0),
    }),
    aiSummary: summary || null,
    accepted: true,
    isPublicSource: true,
    sourceOwnerUserId: null,
  };
}

function huggingFaceItem(row, topicId, sourceId) {
  const publishedAt = firstValidDate(
    row.published_hint,
    row.first_seen_at,
    row.fetched_at,
  );
  const fetchedAt = firstValidDate(row.fetched_at, row.last_seen_at, row.first_seen_at);
  if (!publishedAt || !fetchedAt) return null;
  const content = String(row.summary || "").trim();
  const paperId = String(row.paper_id);
  return {
    topicId,
    sourceId,
    externalId: `paper:${paperId}`,
    contentHash: computeContentHash(row.title, content),
    title: String(row.title),
    content: content || null,
    author: truncate(row.authors, 200),
    authorAvatar: null,
    url: truncate(row.hf_url || `https://huggingface.co/papers/${paperId}`, 1000),
    publishedAt,
    fetchedAt,
    raw: cleanJson({
      provider: "hugging_face",
      kind: "paper",
      evidence: {
        externalId: paperId,
        url: row.hf_url,
        arxivUrl: row.arxiv_url,
        observedAt: fetchedAt.toISOString(),
      },
      dailyPaper: safeJson(row.raw_json, {}),
      migration: { marker: MARKER, source: "solar-harness" },
      legacy: {
        sourceKind: row.source_kind,
        topicTags: safeJson(row.topic_tags, row.topic_tags || []),
        dailyHistory: safeJson(row.daily_history_json, []),
        trendingHistory: safeJson(row.trending_history_json, []),
        periodHistory: safeJson(row.period_history_json, []),
      },
    }),
    metrics: cleanJson({
      rank: Number(row.rank || 0),
      scoreText: row.score_text || "",
    }),
    aiSummary: null,
    accepted: true,
    isPublicSource: true,
    sourceOwnerUserId: null,
  };
}

function youtubeItem(row, topicId, sourceId) {
  const publishedAt = firstValidDate(row.published_at, row.fetched_at);
  const fetchedAt = firstValidDate(row.fetched_at, row.published_at);
  if (!publishedAt || !fetchedAt) return null;
  const transcript = String(row.transcript_clean || "").trim();
  const transcriptAccepted =
    row.transcript_status === "fetched" && transcript.length >= 200;
  const description = String(row.description || "").trim();
  const content = transcriptAccepted ? transcript : description;
  return {
    topicId,
    sourceId,
    externalId: String(row.video_id),
    contentHash: computeContentHash(row.title, content),
    title: String(row.title),
    content: content || null,
    author: truncate(row.channel_name, 200),
    authorAvatar: null,
    url: truncate(row.video_url, 1000),
    publishedAt,
    fetchedAt,
    raw: cleanJson({
      videoId: row.video_id,
      thumbnail: row.thumbnail_url,
      channelId: row.channel_id,
      evidence: {
        provider: "youtube",
        externalId: row.video_id,
        url: row.video_url,
        observedAt: fetchedAt.toISOString(),
        transcript: {
          status: transcriptAccepted ? "accepted" : row.transcript_status || "missing",
          charCount: Number(row.transcript_char_count || transcript.length || 0),
          source: row.transcript_source,
          language: row.transcript_language,
          fetchedAt: row.transcript_fetched_at,
          autoGenerated: Boolean(row.is_auto_generated),
          model: row.transcript_model,
          modelVersion: row.transcript_model_version,
          transcriptHash: row.transcript_hash,
          qualityScore: row.quality_score,
          qualityTier: row.quality_tier,
          coverageRatio: row.coverage_ratio,
          hallucinationRisk: row.hallucination_risk,
        },
      },
      migration: { marker: MARKER, source: "solar-harness" },
      legacy: {
        durationSeconds: row.duration_seconds,
        tags: safeJson(row.tags, row.tags || []),
        metricHistory: safeJson(row.history_json, []),
      },
    }),
    metrics: cleanJson({
      views: Number(row.view_count || 0),
      likes: Number(row.like_count || 0),
      comments: Number(row.comment_count || 0),
    }),
    aiSummary: null,
    accepted: true,
    isPublicSource: true,
    sourceOwnerUserId: null,
  };
}

function creatorItem(row, topicId, sourceId) {
  const publishedAt = firstValidDate(row.created_at, row.fetched_at);
  const fetchedAt = firstValidDate(row.fetched_at, row.created_at);
  if (!publishedAt || !fetchedAt) return null;
  const content = String(row.text || "").trim();
  const title = `@${row.author_handle}: ${content.slice(0, 160)}`;
  const viewpoint = safeJson(row.viewpoint_json, {});
  return {
    topicId,
    sourceId,
    externalId: String(row.post_id),
    contentHash: computeContentHash(title, content),
    title,
    content: content || null,
    author: truncate(row.display_name || `@${row.author_handle}`, 200),
    authorAvatar: null,
    url: truncate(row.post_url || null, 1000),
    publishedAt,
    fetchedAt,
    raw: cleanJson({
      handle: row.author_handle,
      platform: row.platform || "x",
      evidence: {
        provider: "x",
        externalId: row.post_id,
        url: row.post_url,
        observedAt: fetchedAt.toISOString(),
      },
      migration: { marker: MARKER, source: "solar-harness" },
      legacy: {
        category: row.author_category,
        tier: row.author_tier,
        language: row.lang,
        mediaUrls: safeJson(row.media_urls, row.media_urls || []),
        mentionedHandles: safeJson(
          row.mentioned_handles,
          row.mentioned_handles || [],
        ),
        urls: safeJson(row.urls, row.urls || []),
        collectionBackend: row.collection_backend,
        dedupKey: row.dedup_key,
        viewpoint,
        metricHistory: safeJson(row.history_json, []),
      },
    }),
    metrics: cleanJson({
      replies: Number(row.reply_count || 0),
      reposts: Number(row.repost_count || 0),
      quotes: Number(row.quote_count || 0),
      likes: Number(row.like_count || 0),
      views: Number(row.view_count || 0),
      bookmarks: Number(row.bookmarks || 0),
    }),
    aiSummary: viewpoint.viewpoint || null,
    ...(viewpoint.relatedEntities
      ? { entities: cleanJson(viewpoint.relatedEntities) }
      : {}),
    accepted: true,
    isPublicSource: true,
    sourceOwnerUserId: null,
  };
}

function runSelfTest() {
  const malformed = normalizeLegacyTimestamp("2026-05-30T02:12:000000Z");
  if (!malformed || malformed.toISOString() !== "2026-05-30T02:12:00.000Z") {
    throw new Error("legacy timestamp normalization failed");
  }
  const hash = computeContentHash(" A  B ", " C   D ");
  const same = computeContentHash("a b", "c d");
  if (hash !== same || hash.length !== 64) throw new Error("content hash failed");
  if (safeJson("not-json", []).length !== 0) throw new Error("safeJson failed");
  const invalidUnicode = `a${String.fromCharCode(0, 0xd800)}b${String.fromCharCode(0xdc00)}c`;
  const sanitized = sanitizeLegacyString(invalidUnicode);
  if (sanitized !== "a��b�c") {
    throw new Error("legacy string sanitization failed");
  }
  console.log(JSON.stringify({ ok: true, marker: MARKER }, null, 2));
}

function writeReport(reportDir, name, data) {
  fs.mkdirSync(reportDir, { recursive: true });
  const target = path.join(reportDir, name);
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
  return target;
}

async function loadPrisma(args) {
  require("dotenv").config({ path: args.envPath, quiet: true });
  const { PrismaClient } = require("@prisma/client");
  return new PrismaClient();
}

async function assertOwner(prisma, ownerUserId) {
  if (!ownerUserId) throw new Error("--owner-user-id is required");
  const owner = await prisma.user.findUnique({
    where: { id: ownerUserId },
    select: { id: true, role: true, isActive: true },
  });
  if (!owner || !owner.isActive || owner.role !== "ADMIN") {
    throw new Error("owner must exist and be an active ADMIN");
  }
  return owner;
}

function topicDescription(dataset) {
  return `[migration:${MARKER}] 从 solar-harness 只读历史快照迁入的 ${dataset} canonical 数据；旧分析与指标历史保存在 RadarItem.raw.legacy。`;
}

async function findMigrationTopic(prisma, ownerUserId, definition) {
  const matches = await prisma.radarTopic.findMany({
    where: {
      userId: ownerUserId,
      name: definition.name,
      description: { contains: MARKER },
    },
  });
  if (matches.length > 1) {
    throw new Error(`duplicate migration topics found: ${definition.name}`);
  }
  return matches[0] || null;
}

async function ensureTopic(prisma, ownerUserId, key, definition) {
  const existing = await findMigrationTopic(prisma, ownerUserId, definition);
  if (existing) {
    if (existing.status !== "PAUSED" || existing.nextDueAt !== null) {
      return prisma.radarTopic.update({
        where: { id: existing.id },
        data: { status: "PAUSED", nextDueAt: null },
      });
    }
    return existing;
  }
  return prisma.radarTopic.create({
    data: {
      userId: ownerUserId,
      visibility: "PRIVATE",
      name: definition.name,
      description: topicDescription(key),
      entityType: definition.entityType,
      keywords: definition.keywords,
      matchMode: "semantic",
      refreshCron: "0 */6 * * *",
      status: "PAUSED",
      nextDueAt: null,
      outputLanguage: "zh-CN",
    },
  });
}

async function ensureSource(prisma, input) {
  const existing = await prisma.radarSource.findFirst({
    where: {
      topicId: input.topicId,
      type: input.type,
      identifier: input.identifier,
    },
  });
  const data = {
    label: truncate(input.label, 200),
    config: cleanJson(input.config || {}),
    enabled: true,
    isAiRecommended: false,
    authorityWeight: Math.min(5, Math.max(1, Math.round(input.authorityWeight || 3))),
    isPublicSource: true,
    health: "HEALTHY",
    consecutiveFailures: 0,
    cooldownUntil: null,
    lastFetchAt: input.lastFetchAt || null,
    lastError: null,
  };
  if (existing) {
    return prisma.radarSource.update({ where: { id: existing.id }, data });
  }
  return prisma.radarSource.create({
    data: {
      topicId: input.topicId,
      type: input.type,
      identifier: input.identifier,
      ...data,
    },
  });
}

async function ensureTopology(prisma, args) {
  const topics = {};
  for (const [key, definition] of Object.entries(TOPICS)) {
    topics[key] = await ensureTopic(prisma, args.ownerUserId, key, definition);
  }

  const latest = sqliteJson(
    args.sourceDb,
    `SELECT
       (SELECT max(fetched_at) FROM github_repos) AS github_at,
       (SELECT max(fetched_at) FROM hf_daily_papers) AS hf_at,
       (SELECT max(fetched_at) FROM youtube_videos) AS youtube_at,
       (SELECT max(fetched_at) FROM social_posts) AS creators_at`,
  )[0];

  const githubSource = await ensureSource(prisma, {
    topicId: topics.github.id,
    type: "GITHUB",
    identifier: "trending",
    label: "Solar 历史 GitHub 趋势",
    config: { minStars: 0, sort: "stars", migration: { marker: MARKER } },
    lastFetchAt: firstValidDate(latest.github_at),
  });
  const huggingFaceSource = await ensureSource(prisma, {
    topicId: topics.huggingFace.id,
    type: "HUGGING_FACE",
    identifier: "papers",
    label: "Solar 历史 Hugging Face Papers",
    config: { migration: { marker: MARKER } },
    lastFetchAt: firstValidDate(latest.hf_at),
  });

  const youtubeSources = new Map();
  const channels = sqliteJson(
    args.sourceDb,
    `SELECT c.*, max(v.fetched_at) AS latest_fetch_at
     FROM youtube_channels c
     LEFT JOIN youtube_videos v ON v.channel_id=c.channel_id
     GROUP BY c.channel_id
     ORDER BY c.channel_id`,
  );
  for (const channel of channels) {
    const source = await ensureSource(prisma, {
      topicId: topics.youtube.id,
      type: "YOUTUBE",
      identifier: String(channel.channel_id),
      label: channel.channel_name,
      config: {
        fetchTranscript: true,
        transcriptMinChars: 200,
        migration: { marker: MARKER, category: channel.category },
      },
      authorityWeight: channel.priority === "core" ? 5 : 3,
      lastFetchAt: firstValidDate(channel.latest_fetch_at, channel.last_scanned_at),
    });
    youtubeSources.set(String(channel.channel_id), source.id);
  }

  const creatorSources = new Map();
  const accounts = sqliteJson(
    args.sourceDb,
    `SELECT a.*, max(p.fetched_at) AS latest_fetch_at
     FROM social_accounts a
     LEFT JOIN social_posts p ON p.author_handle=a.handle
     GROUP BY a.handle
     ORDER BY a.handle`,
  );
  for (const account of accounts) {
    const source = await ensureSource(prisma, {
      topicId: topics.creators.id,
      type: "X",
      identifier: String(account.handle).replace(/^@/, ""),
      label: account.display_name || `@${account.handle}`,
      config: {
        migration: {
          marker: MARKER,
          category: account.category,
          tier: account.tier,
          collectionBackend: account.collection_backend,
        },
      },
      authorityWeight: Number(account.weight || 3),
      lastFetchAt: firstValidDate(
        account.latest_fetch_at,
        account.last_success_at,
        account.last_scanned_at,
      ),
    });
    creatorSources.set(String(account.handle), source.id);
  }

  return {
    topics,
    githubSourceId: githubSource.id,
    huggingFaceSourceId: huggingFaceSource.id,
    youtubeSources,
    creatorSources,
  };
}

async function targetStats(prisma, ownerUserId) {
  const result = {};
  let totalSources = 0;
  let totalItems = 0;
  for (const [key, definition] of Object.entries(TOPICS)) {
    const topic = await findMigrationTopic(prisma, ownerUserId, definition);
    if (!topic) {
      result[key] = { topic: 0, sources: 0, items: 0, status: "missing" };
      continue;
    }
    const [sources, items] = await Promise.all([
      prisma.radarSource.count({ where: { topicId: topic.id } }),
      prisma.radarItem.count({ where: { topicId: topic.id } }),
    ]);
    totalSources += sources;
    totalItems += items;
    result[key] = {
      topic: 1,
      topicId: topic.id,
      sources,
      items,
      status: topic.status,
      nextDueAt: topic.nextDueAt,
    };
  }
  return { datasets: result, totalSources, totalItems };
}

async function importBatches({
  prisma,
  args,
  name,
  topicId,
  total,
  fetchBatch,
  mapItem,
  report,
}) {
  const existing = await prisma.radarItem.count({ where: { topicId } });
  if (existing >= total) {
    const result = {
      total,
      processed: 0,
      inserted: 0,
      skipped: 0,
      existing,
      resumeSkipped: true,
    };
    report.datasets[name] = result;
    writeReport(args.reportDir, "migration-progress.json", report);
    console.log(`[${name}] resume-skip existing=${existing}/${total}`);
    return result;
  }
  let processed = 0;
  let skipped = 0;
  let inserted = 0;
  for (let offset = 0; offset < total; offset += args.batchSize) {
    const rows = fetchBatch(args.sourceDb, args.batchSize, offset);
    const items = [];
    for (const row of rows) {
      const item = mapItem(row);
      if (item) items.push(cleanJson(item));
      else skipped += 1;
    }
    const before = await prisma.radarItem.count({
      where: { topicId: items[0]?.topicId || "__none__" },
    });
    if (items.length) {
      await prisma.radarItem.createMany({ data: items, skipDuplicates: true });
    }
    const after = await prisma.radarItem.count({
      where: { topicId: items[0]?.topicId || "__none__" },
    });
    inserted += Math.max(0, after - before);
    processed += rows.length;
    report.datasets[name] = { total, processed, inserted, skipped };
    writeReport(args.reportDir, "migration-progress.json", report);
    console.log(
      `[${name}] processed=${processed}/${total} inserted=${inserted} skipped=${skipped}`,
    );
  }
  return { total, processed, inserted, skipped };
}

function auditBatches({ args, name, total, fetchBatch, mapItem }) {
  let mapped = 0;
  let skipped = 0;
  for (let offset = 0; offset < total; offset += args.batchSize) {
    const rows = fetchBatch(args.sourceDb, args.batchSize, offset);
    for (const row of rows) {
      if (mapItem(row)) mapped += 1;
      else skipped += 1;
    }
    console.log(`[dry-run:${name}] checked=${mapped + skipped}/${total} skipped=${skipped}`);
  }
  return { total, mapped, skipped };
}

async function executeMigration(prisma, args, stats) {
  const before = await targetStats(prisma, args.ownerUserId);
  const topology = await ensureTopology(prisma, args);
  const report = {
    marker: MARKER,
    mode: "execute",
    startedAt: new Date().toISOString(),
    sourceDb: args.sourceDb,
    ownerUserId: args.ownerUserId,
    batchSize: args.batchSize,
    source: stats,
    targetBefore: before,
    datasets: {},
  };
  writeReport(args.reportDir, "migration-progress.json", report);

  await importBatches({
    prisma,
    args,
    name: "github",
    topicId: topology.topics.github.id,
    total: stats.github,
    fetchBatch: githubBatch,
    mapItem: (row) =>
      githubItem(row, topology.topics.github.id, topology.githubSourceId),
    report,
  });
  await importBatches({
    prisma,
    args,
    name: "huggingFace",
    topicId: topology.topics.huggingFace.id,
    total: stats.huggingFace,
    fetchBatch: huggingFaceBatch,
    mapItem: (row) =>
      huggingFaceItem(
        row,
        topology.topics.huggingFace.id,
        topology.huggingFaceSourceId,
      ),
    report,
  });
  await importBatches({
    prisma,
    args,
    name: "youtube",
    topicId: topology.topics.youtube.id,
    total: stats.youtube,
    fetchBatch: youtubeBatch,
    mapItem: (row) => {
      const sourceId = topology.youtubeSources.get(String(row.channel_id));
      if (!sourceId) return null;
      return youtubeItem(row, topology.topics.youtube.id, sourceId);
    },
    report,
  });
  await importBatches({
    prisma,
    args,
    name: "creators",
    topicId: topology.topics.creators.id,
    total: stats.creators,
    fetchBatch: creatorBatch,
    mapItem: (row) => {
      const sourceId = topology.creatorSources.get(String(row.author_handle));
      if (!sourceId) return null;
      return creatorItem(row, topology.topics.creators.id, sourceId);
    },
    report,
  });

  report.targetAfter = await targetStats(prisma, args.ownerUserId);
  report.completedAt = new Date().toISOString();
  report.ok =
    report.targetAfter.totalItems >=
      stats.github + stats.huggingFace + stats.youtube + stats.creators &&
    Object.values(report.targetAfter.datasets).every(
      (dataset) => dataset.status === "PAUSED" && dataset.nextDueAt === null,
    );
  const reportPath = writeReport(args.reportDir, "migration-result.json", report);
  console.log(JSON.stringify({ ok: report.ok, reportPath, target: report.targetAfter }, null, 2));
  if (!report.ok) process.exitCode = 2;
}

async function verifyMigration(prisma, args, stats) {
  const target = await targetStats(prisma, args.ownerUserId);
  const expected = {
    github: stats.github,
    huggingFace: stats.huggingFace,
    youtube: stats.youtube,
    creators: stats.creators,
  };
  const checks = [];
  for (const [key, count] of Object.entries(expected)) {
    const dataset = target.datasets[key];
    checks.push({
      name: `${key}.count`,
      ok: dataset.items >= count,
      expected: count,
      actual: dataset.items,
    });
    checks.push({
      name: `${key}.paused`,
      ok: dataset.status === "PAUSED" && dataset.nextDueAt === null,
      expected: "PAUSED/null",
      actual: `${dataset.status}/${dataset.nextDueAt}`,
    });
  }
  checks.push({
    name: "source.count",
    ok: target.totalSources === 2 + stats.youtubeChannels + stats.creatorAccounts,
    expected: 2 + stats.youtubeChannels + stats.creatorAccounts,
    actual: target.totalSources,
  });

  const topicIds = Object.values(target.datasets)
    .map((dataset) => dataset.topicId)
    .filter(Boolean);
  const [acceptedItems, acceptedTranscripts, creatorSummaries, runs, insights] =
    await Promise.all([
      prisma.radarItem.count({
        where: { topicId: { in: topicIds }, accepted: true },
      }),
      prisma.radarItem.count({
        where: {
          topicId: target.datasets.youtube.topicId,
          raw: { path: ["evidence", "transcript", "status"], equals: "accepted" },
        },
      }),
      prisma.radarItem.count({
        where: {
          topicId: target.datasets.creators.topicId,
          aiSummary: { not: null },
        },
      }),
      prisma.radarRun.count({ where: { topicId: { in: topicIds } } }),
      prisma.radarInsight.count({ where: { topicId: { in: topicIds } } }),
    ]);
  const expectedItems = Object.values(expected).reduce((sum, count) => sum + count, 0);
  checks.push(
    {
      name: "item.accepted",
      ok: acceptedItems === expectedItems,
      expected: expectedItems,
      actual: acceptedItems,
    },
    {
      name: "youtube.acceptedTranscripts",
      ok: acceptedTranscripts === stats.acceptedTranscripts,
      expected: stats.acceptedTranscripts,
      actual: acceptedTranscripts,
    },
    {
      name: "creators.aiSummaries",
      ok: creatorSummaries === stats.creatorViewpoints,
      expected: stats.creatorViewpoints,
      actual: creatorSummaries,
    },
    {
      name: "scheduler.runs",
      ok: runs === 0,
      expected: 0,
      actual: runs,
    },
    {
      name: "scheduler.insights",
      ok: insights === 0,
      expected: 0,
      actual: insights,
    },
  );

  const samples = {};
  for (const [key, dataset] of Object.entries(target.datasets)) {
    if (!dataset.topicId) continue;
    const sample = await prisma.radarItem.findFirst({
      where: { topicId: dataset.topicId },
      select: { externalId: true, raw: true, aiSummary: true },
      orderBy: { externalId: "asc" },
    });
    samples[key] = sample
      ? {
          externalId: sample.externalId,
          marker: sample.raw?.migration?.marker || null,
          provider:
            sample.raw?.provider || sample.raw?.evidence?.provider || null,
          hasLegacyPayload: Boolean(sample.raw?.legacy),
          hasAiSummary: Boolean(sample.aiSummary),
        }
      : null;
  }
  checks.push({
    name: "sample.marker",
    ok: Object.values(samples).every((sample) => sample?.marker === MARKER),
    expected: MARKER,
    actual: Object.fromEntries(
      Object.entries(samples).map(([key, value]) => [key, value?.marker]),
    ),
  });

  const report = {
    marker: MARKER,
    mode: "verify",
    verifiedAt: new Date().toISOString(),
    source: stats,
    target,
    samples,
    checks,
    ok: checks.every((check) => check.ok),
  };
  const reportPath = writeReport(args.reportDir, "verification-result.json", report);
  console.log(JSON.stringify({ ok: report.ok, reportPath, checks }, null, 2));
  if (!report.ok) process.exitCode = 2;
}

async function rollbackMigration(prisma, args) {
  if (args.confirmRollback !== MARKER) {
    throw new Error(`rollback requires --confirm-rollback ${MARKER}`);
  }
  const topics = [];
  for (const definition of Object.values(TOPICS)) {
    const topic = await findMigrationTopic(prisma, args.ownerUserId, definition);
    if (topic) topics.push(topic);
  }
  const before = await targetStats(prisma, args.ownerUserId);
  const result = await prisma.radarTopic.deleteMany({
    where: { id: { in: topics.map((topic) => topic.id) }, userId: args.ownerUserId },
  });
  const report = {
    marker: MARKER,
    mode: "rollback",
    rolledBackAt: new Date().toISOString(),
    before,
    deletedTopics: result.count,
  };
  const reportPath = writeReport(args.reportDir, "rollback-result.json", report);
  console.log(JSON.stringify({ ok: true, reportPath, deletedTopics: result.count }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "help") return printHelp();
  if (args.mode === "self-test") return runSelfTest();
  if (!["dry-run", "execute", "verify", "rollback"].includes(args.mode)) {
    throw new Error(`Unsupported mode: ${args.mode}`);
  }

  const quickCheck = sourceQuickCheck(args.sourceDb);
  if (!quickCheck.ok) {
    throw new Error(`source SQLite quick_check failed: ${quickCheck.messages.join("; ")}`);
  }
  const stats = sourceStats(args.sourceDb);
  const expectedItems = stats.github + stats.huggingFace + stats.youtube + stats.creators;
  const expectedSources = 2 + stats.youtubeChannels + stats.creatorAccounts;

  if (args.mode === "dry-run") {
    const youtubeChannels = new Set(
      sqliteJson(args.sourceDb, "SELECT channel_id FROM youtube_channels").map(
        (row) => String(row.channel_id),
      ),
    );
    const creatorAccounts = new Set(
      sqliteJson(args.sourceDb, "SELECT handle FROM social_accounts").map((row) =>
        String(row.handle),
      ),
    );
    const canonicalAudit = {
      github: auditBatches({
        args,
        name: "github",
        total: stats.github,
        fetchBatch: githubBatch,
        mapItem: (row) => githubItem(row, "dry-topic", "dry-source"),
      }),
      huggingFace: auditBatches({
        args,
        name: "huggingFace",
        total: stats.huggingFace,
        fetchBatch: huggingFaceBatch,
        mapItem: (row) => huggingFaceItem(row, "dry-topic", "dry-source"),
      }),
      youtube: auditBatches({
        args,
        name: "youtube",
        total: stats.youtube,
        fetchBatch: youtubeBatch,
        mapItem: (row) =>
          youtubeChannels.has(String(row.channel_id))
            ? youtubeItem(row, "dry-topic", "dry-source")
            : null,
      }),
      creators: auditBatches({
        args,
        name: "creators",
        total: stats.creators,
        fetchBatch: creatorBatch,
        mapItem: (row) =>
          creatorAccounts.has(String(row.author_handle))
            ? creatorItem(row, "dry-topic", "dry-source")
            : null,
      }),
    };
    const mappedItems = Object.values(canonicalAudit).reduce(
      (sum, dataset) => sum + dataset.mapped,
      0,
    );
    const skippedItems = Object.values(canonicalAudit).reduce(
      (sum, dataset) => sum + dataset.skipped,
      0,
    );
    const sampleRows = {
      github: githubBatch(args.sourceDb, 2, 0).map((row) => ({
        externalId: row.full_name,
        publishedAt: firstValidDate(
          row.pushed_at,
          row.updated_at,
          row.created_at,
          row.fetched_at,
        )?.toISOString(),
      })),
      huggingFace: huggingFaceBatch(args.sourceDb, 2, 0).map((row) => ({
        externalId: `paper:${row.paper_id}`,
        publishedAt: firstValidDate(row.published_hint, row.first_seen_at)?.toISOString(),
      })),
      youtube: youtubeBatch(args.sourceDb, 2, 0).map((row) => ({
        externalId: row.video_id,
        publishedAt: firstValidDate(row.published_at, row.fetched_at)?.toISOString(),
      })),
      creators: creatorBatch(args.sourceDb, 2, 0).map((row) => ({
        externalId: row.post_id,
        publishedAt: firstValidDate(row.created_at, row.fetched_at)?.toISOString(),
      })),
    };
    const report = {
      marker: MARKER,
      mode: "dry-run",
      generatedAt: new Date().toISOString(),
      sourceDb: args.sourceDb,
      sourceQuickCheck: quickCheck,
      source: stats,
      planned: { topics: 4, sources: expectedSources, items: mappedItems },
      canonicalAudit,
      sampleRows,
      writesPerformed: false,
      ok: mappedItems === expectedItems && skippedItems === 0,
    };
    const reportPath = writeReport(args.reportDir, "dry-run-result.json", report);
    console.log(JSON.stringify({ reportPath, ...report }, null, 2));
    if (!report.ok) process.exitCode = 2;
    return;
  }

  const prisma = await loadPrisma(args);
  try {
    await assertOwner(prisma, args.ownerUserId);
    if (args.mode === "execute") await executeMigration(prisma, args, stats);
    else if (args.mode === "verify") await verifyMigration(prisma, args, stats);
    else await rollbackMigration(prisma, args);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`migration error: ${error.message}`);
  process.exitCode = 1;
});
