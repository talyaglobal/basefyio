/**
 * TikTok-Style Mobile Modeling Fixture — Phase 1b Hard Gate
 *
 * This fixture proves the type system can represent a full TikTok-like app:
 *   - Entity definitions (users, videos, comments, reactions, follows)
 *   - Nested schemas (media, authorSnapshot, stats)
 *   - Counter fields (views, likes, comments, shares)
 *   - Virtual viewerState (never stored in documents)
 *   - Offline sync fields (_version, _eventSequence)
 *   - Projection (mobileFeedCard)
 *   - Mobile screen models
 *   - AI structure decisions with provenance
 *
 * This file MUST compile against the Phase 1 contracts.
 * It is kept in CI permanently as a regression guard.
 */

import type {
  EntityDefinitionMeta,
  EntityField,
  AppProjectionDef,
  MobileScreenModel,
  StructureDecisionRecord,
  ValidationRule,
  EntityRule,
} from '../interfaces/schema';

import type {
  DocResult,
  StoredDocument,
  DocumentEnvelope,
} from '../interfaces/types';

import type {
  EntityQuery,
  EntityAggregation,
  Filter,
  PathRef,
  IndexDef,
} from '../interfaces/query';

// ── Entity Definitions ─────────────────────────────────────

const usersEntity: EntityDefinitionMeta = {
  id: 'ent_users',
  projectId: 'prj_tiktok',
  logicalName: 'users',
  displayName: 'Users',
  physicalCollection: 'records',
  storageStrategy: 'shared-records',
  provider: 'nosql',
  storageClass: 'standard',
  schemaVersion: 1,
  generatedByAI: true,
  description: 'User profiles with nested settings and avatar',
  aiPrompt: 'Create a TikTok-like social video app',
  aiReasoning: { category: 'social', detected: 'user-profile-pattern' },
  confidenceScore: 0.95,
  fields: [
    {
      id: 'f_username', name: 'username', displayName: 'Username',
      kind: 'scalar', type: 'text', required: true, unique: true, indexed: true,
      validationRules: [
        { id: 'vr1', type: 'minLength', config: { value: 3 } },
        { id: 'vr2', type: 'maxLength', config: { value: 30 } },
        { id: 'vr3', type: 'regex', config: { pattern: '^[a-zA-Z0-9_]+$' } },
      ],
    },
    {
      id: 'f_displayName', name: 'displayName', displayName: 'Display Name',
      kind: 'scalar', type: 'text', required: true, unique: false, indexed: false,
      validationRules: [{ id: 'vr4', type: 'maxLength', config: { value: 50 } }],
    },
    {
      id: 'f_bio', name: 'bio', displayName: 'Bio',
      kind: 'scalar', type: 'longText', required: false, unique: false, indexed: false,
      validationRules: [{ id: 'vr5', type: 'maxLength', config: { value: 500 } }],
    },
    {
      id: 'f_avatar', name: 'avatar', displayName: 'Avatar',
      kind: 'media', required: false, unique: false, indexed: false,
      validationRules: [],
    },
    {
      id: 'f_verified', name: 'verified', displayName: 'Verified',
      kind: 'scalar', type: 'boolean', required: false, unique: false, indexed: true,
      validationRules: [], defaultValue: false,
    },
    {
      id: 'f_stats', name: 'stats', displayName: 'Profile Stats',
      kind: 'object', required: false, unique: false, indexed: false,
      validationRules: [],
      children: [
        { id: 'f_followers', name: 'followers', displayName: 'Followers', kind: 'counter', required: false, unique: false, indexed: false, validationRules: [], counterInitial: 0 },
        { id: 'f_following', name: 'following', displayName: 'Following', kind: 'counter', required: false, unique: false, indexed: false, validationRules: [], counterInitial: 0 },
        { id: 'f_totalLikes', name: 'totalLikes', displayName: 'Total Likes', kind: 'counter', required: false, unique: false, indexed: false, validationRules: [], counterInitial: 0 },
      ],
    },
    {
      id: 'f_settings', name: 'settings', displayName: 'User Settings',
      kind: 'object', required: false, unique: false, indexed: false,
      validationRules: [],
      children: [
        { id: 'f_privacy', name: 'privacy', displayName: 'Privacy', kind: 'scalar', type: 'text', required: false, unique: false, indexed: false, validationRules: [], defaultValue: 'public' },
        { id: 'f_notifications', name: 'notifications', displayName: 'Notifications', kind: 'scalar', type: 'boolean', required: false, unique: false, indexed: false, validationRules: [], defaultValue: true },
      ],
    },
  ],
  rules: [],
  createdAt: '2026-06-09T00:00:00Z',
  updatedAt: '2026-06-09T00:00:00Z',
};

const videosEntity: EntityDefinitionMeta = {
  id: 'ent_videos',
  projectId: 'prj_tiktok',
  logicalName: 'videos',
  displayName: 'Videos',
  physicalCollection: 'videos',
  storageStrategy: 'collection',
  provider: 'nosql',
  storageClass: 'standard',
  schemaVersion: 1,
  generatedByAI: true,
  description: 'Video posts with embedded author snapshot, media metadata, and stats',
  confidenceScore: 0.91,
  sourceWorkbook: 'social_app_spec.xlsx',
  sourceSheet: 'Content',
  fields: [
    {
      id: 'f_title', name: 'title', displayName: 'Title',
      kind: 'scalar', type: 'text', required: true, unique: false, indexed: false,
      validationRules: [{ id: 'vr10', type: 'maxLength', config: { value: 200 } }],
    },
    {
      id: 'f_description', name: 'description', displayName: 'Description',
      kind: 'scalar', type: 'longText', required: false, unique: false, indexed: false,
      validationRules: [],
    },
    {
      id: 'f_media', name: 'media', displayName: 'Video Media',
      kind: 'media', required: true, unique: false, indexed: false,
      validationRules: [],
    },
    {
      id: 'f_authorSnapshot', name: 'authorSnapshot', displayName: 'Author',
      kind: 'object', required: true, unique: false, indexed: false,
      validationRules: [],
      children: [
        { id: 'f_as_userId', name: 'userId', displayName: 'User ID', kind: 'scalar', type: 'text', required: true, unique: false, indexed: true, validationRules: [] },
        { id: 'f_as_username', name: 'username', displayName: 'Username', kind: 'scalar', type: 'text', required: true, unique: false, indexed: false, validationRules: [] },
        { id: 'f_as_displayName', name: 'displayName', displayName: 'Display Name', kind: 'scalar', type: 'text', required: true, unique: false, indexed: false, validationRules: [] },
        { id: 'f_as_avatarUrl', name: 'avatarUrl', displayName: 'Avatar URL', kind: 'scalar', type: 'url', required: false, unique: false, indexed: false, validationRules: [] },
        { id: 'f_as_verified', name: 'verified', displayName: 'Verified', kind: 'scalar', type: 'boolean', required: false, unique: false, indexed: false, validationRules: [] },
      ],
    },
    {
      id: 'f_hashtags', name: 'hashtags', displayName: 'Hashtags',
      kind: 'array', required: false, unique: false, indexed: true,
      validationRules: [],
      itemSchema: { id: 'f_hashtag_item', name: 'hashtag', displayName: 'Hashtag', kind: 'scalar', type: 'text', required: true, unique: false, indexed: false, validationRules: [] },
    },
    {
      id: 'f_stats', name: 'stats', displayName: 'Video Stats',
      kind: 'object', required: false, unique: false, indexed: false,
      validationRules: [],
      children: [
        { id: 'f_views', name: 'views', displayName: 'Views', kind: 'counter', required: false, unique: false, indexed: false, validationRules: [], counterInitial: 0 },
        { id: 'f_likes', name: 'likes', displayName: 'Likes', kind: 'counter', required: false, unique: false, indexed: false, validationRules: [], counterInitial: 0 },
        { id: 'f_comments', name: 'comments', displayName: 'Comments', kind: 'counter', required: false, unique: false, indexed: false, validationRules: [], counterInitial: 0 },
        { id: 'f_shares', name: 'shares', displayName: 'Shares', kind: 'counter', required: false, unique: false, indexed: false, validationRules: [], counterInitial: 0 },
        { id: 'f_saves', name: 'saves', displayName: 'Saves', kind: 'counter', required: false, unique: false, indexed: false, validationRules: [], counterInitial: 0 },
      ],
    },
    {
      id: 'f_moderation', name: 'moderation', displayName: 'Moderation',
      kind: 'object', required: false, unique: false, indexed: false,
      validationRules: [],
      children: [
        { id: 'f_mod_status', name: 'status', displayName: 'Status', kind: 'scalar', type: 'text', required: false, unique: false, indexed: true, validationRules: [] },
        { id: 'f_mod_reviewedAt', name: 'reviewedAt', displayName: 'Reviewed At', kind: 'scalar', type: 'datetime', required: false, unique: false, indexed: false, validationRules: [] },
        { id: 'f_mod_flags', name: 'flags', displayName: 'Flags', kind: 'array', required: false, unique: false, indexed: false, validationRules: [], itemSchema: { id: 'f_flag_item', name: 'flag', displayName: 'Flag', kind: 'scalar', type: 'text', required: false, unique: false, indexed: false, validationRules: [] } },
      ],
    },
    {
      id: 'f_music', name: 'music', displayName: 'Music Track',
      kind: 'object', required: false, unique: false, indexed: false,
      validationRules: [],
      children: [
        { id: 'f_mu_trackId', name: 'trackId', displayName: 'Track ID', kind: 'scalar', type: 'text', required: false, unique: false, indexed: false, validationRules: [] },
        { id: 'f_mu_title', name: 'title', displayName: 'Title', kind: 'scalar', type: 'text', required: false, unique: false, indexed: false, validationRules: [] },
        { id: 'f_mu_artist', name: 'artist', displayName: 'Artist', kind: 'scalar', type: 'text', required: false, unique: false, indexed: false, validationRules: [] },
      ],
    },
    // Virtual viewer state — never stored in document
    {
      id: 'f_viewerState', name: 'viewerState', displayName: 'Viewer State',
      kind: 'viewerState', required: false, unique: false, indexed: false,
      validationRules: [],
    },
  ],
  rules: [],
  createdAt: '2026-06-09T00:00:00Z',
  updatedAt: '2026-06-09T00:00:00Z',
};

const commentsEntity: EntityDefinitionMeta = {
  id: 'ent_comments',
  projectId: 'prj_tiktok',
  logicalName: 'comments',
  displayName: 'Comments',
  physicalCollection: 'comments',
  storageStrategy: 'collection',
  provider: 'nosql',
  storageClass: 'standard',
  schemaVersion: 1,
  generatedByAI: true,
  description: 'Video comments with embedded preview replies',
  confidenceScore: 0.88,
  fields: [
    { id: 'f_videoId', name: 'videoId', displayName: 'Video', kind: 'lookup', required: true, unique: false, indexed: true, validationRules: [], lookupEntity: 'videos' },
    {
      id: 'f_authorSnapshot', name: 'authorSnapshot', displayName: 'Author',
      kind: 'object', required: true, unique: false, indexed: false,
      validationRules: [],
      children: [
        { id: 'f_ca_userId', name: 'userId', displayName: 'User ID', kind: 'scalar', type: 'text', required: true, unique: false, indexed: true, validationRules: [] },
        { id: 'f_ca_username', name: 'username', displayName: 'Username', kind: 'scalar', type: 'text', required: true, unique: false, indexed: false, validationRules: [] },
        { id: 'f_ca_avatarUrl', name: 'avatarUrl', displayName: 'Avatar', kind: 'scalar', type: 'url', required: false, unique: false, indexed: false, validationRules: [] },
      ],
    },
    { id: 'f_text', name: 'text', displayName: 'Comment Text', kind: 'scalar', type: 'longText', required: true, unique: false, indexed: false, validationRules: [{ id: 'vr20', type: 'maxLength', config: { value: 2000 } }] },
    { id: 'f_likeCount', name: 'likeCount', displayName: 'Likes', kind: 'counter', required: false, unique: false, indexed: false, validationRules: [], counterInitial: 0 },
    {
      id: 'f_previewReplies', name: 'previewReplies', displayName: 'Preview Replies',
      kind: 'array', required: false, unique: false, indexed: false,
      validationRules: [],
      itemSchema: {
        id: 'f_reply_item', name: 'reply', displayName: 'Reply',
        kind: 'object', required: false, unique: false, indexed: false,
        validationRules: [],
        children: [
          { id: 'f_r_userId', name: 'userId', displayName: 'User ID', kind: 'scalar', type: 'text', required: true, unique: false, indexed: false, validationRules: [] },
          { id: 'f_r_username', name: 'username', displayName: 'Username', kind: 'scalar', type: 'text', required: true, unique: false, indexed: false, validationRules: [] },
          { id: 'f_r_text', name: 'text', displayName: 'Reply Text', kind: 'scalar', type: 'text', required: true, unique: false, indexed: false, validationRules: [] },
        ],
      },
    },
  ],
  rules: [],
  createdAt: '2026-06-09T00:00:00Z',
  updatedAt: '2026-06-09T00:00:00Z',
};

// ── mobileFeedCard Projection ──────────────────────────────

const mobileFeedCardProjection: AppProjectionDef = {
  id: 'proj_feed',
  projectId: 'prj_tiktok',
  name: 'mobileFeedCard',
  sourceEntity: 'videos',
  shape: {
    _id: 'string',
    title: 'string',
    media: { url: 'string', thumbnailUrl: 'string', duration: 'number', aspectRatio: 'string' },
    authorSnapshot: { username: 'string', displayName: 'string', avatarUrl: 'string', verified: 'boolean' },
    hashtags: ['string'],
    stats: { views: 'counter', likes: 'counter', comments: 'counter', shares: 'counter' },
    music: { title: 'string', artist: 'string' },
    viewerState: { liked: 'boolean', saved: 'boolean', following: 'boolean' },
  },
  includes: [
    { field: 'viewerState.liked', source: 'reactions', match: { videoId: '$._id', userId: '$viewer', type: 'like' }, compute: 'exists' },
    { field: 'viewerState.saved', source: 'reactions', match: { videoId: '$._id', userId: '$viewer', type: 'save' }, compute: 'exists' },
    { field: 'viewerState.following', source: 'follows', match: { followerId: '$viewer', followeeId: '$.authorSnapshot.userId' }, compute: 'exists' },
  ],
  computedFields: [],
  cachePolicy: 'feed',
};

// ── Mobile Screen Models ───────────────────────────────────

const feedScreen: MobileScreenModel = {
  id: 'screen_feed',
  name: 'For You Feed',
  route: '/feed',
  type: 'feed',
  dataSource: { type: 'projection', name: 'mobileFeedCard' },
  layout: { type: 'vertical-scroll', fullscreen: true, swipeable: true },
  actions: [
    { name: 'like', type: 'like' },
    { name: 'comment', type: 'navigate', target: '/comments/:videoId' },
    { name: 'share', type: 'share' },
    { name: 'profile', type: 'navigate', target: '/profile/:authorId' },
  ],
};

const profileScreen: MobileScreenModel = {
  id: 'screen_profile',
  name: 'User Profile',
  route: '/profile/:userId',
  type: 'profile',
  dataSource: { type: 'entity', name: 'users' },
  layout: { type: 'profile-header-grid', gridColumns: 3 },
  actions: [
    { name: 'follow', type: 'like' },
    { name: 'message', type: 'navigate', target: '/chat/:userId' },
  ],
};

// ── AI Structure Decisions ─────────────────────────────────

const structureDecisions: StructureDecisionRecord[] = [
  {
    field: 'authorSnapshot',
    decision: 'embedded-object',
    reason: 'Author snapshot is read together with the video, shares the video lifecycle, and is small. Denormalized for feed performance.',
  },
  {
    field: 'media',
    decision: 'embedded-object',
    reason: 'Media metadata belongs to the video lifecycle and is always read together. No independent permissions needed.',
  },
  {
    field: 'stats',
    decision: 'embedded-object',
    reason: 'Stats (counters) are part of the video document. Updated via events, not document rewrites.',
  },
  {
    field: 'comments',
    decision: 'separate-entity-with-lookup',
    reason: 'Comments have independent lifecycle, grow unbounded, need separate permissions and pagination, and require their own workflows (moderation).',
  },
  {
    field: 'previewReplies',
    decision: 'embedded-array',
    reason: 'First 3 replies embedded in comment for preview. Full replies fetched via separate query. Hybrid pattern: embedded for read perf, separate for full list.',
  },
  {
    field: 'reactions',
    decision: 'separate-entity-with-lookup',
    reason: 'Reactions are many-to-many (user × video), queried independently for "liked by" lists, and drive counter events.',
  },
  {
    field: 'follows',
    decision: 'separate-entity-with-lookup',
    reason: 'Follow relationships are queried independently (followers list, following list), have their own lifecycle, and drive counter events.',
  },
];

// ── Sample Video Document (proves StoredDocument shape) ────

const sampleVideoDocument: StoredDocument = {
  _id: 'vid_abc123',
  _entity: 'videos',
  _projectId: 'prj_tiktok',
  _schemaVersion: 1,
  _version: 42,
  _lastEventId: 'evt_xyz789',
  _eventSequence: 42,
  _status: 'active',
  _createdAt: '2026-06-09T10:00:00Z',
  _updatedAt: '2026-06-09T15:30:00Z',
  _createdBy: 'user_creator1',
  _deletedAt: null,

  title: 'Amazing sunset timelapse',
  description: 'Shot in Cappadocia',
  media: {
    url: 'https://cdn.example.com/videos/abc123.mp4',
    thumbnailUrl: 'https://cdn.example.com/thumbs/abc123.jpg',
    duration: 45,
    width: 1080,
    height: 1920,
    aspectRatio: '9:16',
    codec: 'h264',
  },
  authorSnapshot: {
    userId: 'user_creator1',
    username: 'naturelover',
    displayName: 'Nature Lover',
    avatarUrl: 'https://cdn.example.com/avatars/creator1.jpg',
    verified: true,
  },
  hashtags: ['sunset', 'cappadocia', 'timelapse', 'nature'],
  stats: { views: 150000, likes: 12500, comments: 890, shares: 2100, saves: 4500 },
  moderation: { status: 'approved', reviewedAt: '2026-06-09T10:01:00Z', flags: [] },
  music: { trackId: 'track_456', title: 'Peaceful Piano', artist: 'Ambient Studio' },
};

// ── Sample Query (proves query types) ──────────────────────

const feedQuery: EntityQuery = {
  entity: 'videos',
  filter: {
    type: 'and',
    conditions: [
      { type: 'field', path: { path: 'moderation.status', isArrayPath: false }, operator: 'eq', value: 'approved' },
      { type: 'field', path: { path: '_status', isArrayPath: false }, operator: 'eq', value: 'active' },
    ],
  },
  sort: [{ path: { path: '_createdAt', isArrayPath: false }, direction: 'desc' }],
  limit: 20,
};

const hashtagQuery: EntityQuery = {
  entity: 'videos',
  filter: {
    type: 'field',
    path: { path: 'hashtags', isArrayPath: true },
    operator: 'contains',
    value: 'sunset',
  },
  sort: [{ path: { path: 'stats.views', isArrayPath: false }, direction: 'desc' }],
  limit: 50,
};

// ── Sample Aggregation (proves aggregation types) ──────────

const topCreatorsAggregation: EntityAggregation = {
  entity: 'videos',
  pipeline: [
    {
      $match: {
        type: 'field',
        path: { path: 'moderation.status', isArrayPath: false },
        operator: 'eq',
        value: 'approved',
      },
    },
    {
      $group: {
        _id: { path: 'authorSnapshot.userId', isArrayPath: false },
        accumulators: {
          totalViews: { op: '$sum', path: { path: 'stats.views', isArrayPath: false } },
          videoCount: { op: '$count' },
        },
      },
    },
    { $sort: [{ path: { path: 'totalViews', isArrayPath: false }, direction: 'desc' }] },
    { $limit: 10 },
  ],
};

// ── Index Definitions ──────────────────────────────────────

const videoIndexes: IndexDef[] = [
  { name: 'idx_videos_projectId', fields: [{ path: '_projectId' }] },
  { name: 'idx_videos_author', fields: [{ path: 'authorSnapshot.userId' }] },
  { name: 'idx_videos_moderation', fields: [{ path: 'moderation.status' }] },
  { name: 'idx_videos_hashtags', fields: [{ path: 'hashtags' }] },
  { name: 'idx_videos_created', fields: [{ path: '_createdAt', order: 'desc' }] },
];

// ── Export for CI verification ─────────────────────────────

export const TIKTOK_FIXTURE = {
  entities: { users: usersEntity, videos: videosEntity, comments: commentsEntity },
  projections: { mobileFeedCard: mobileFeedCardProjection },
  screens: { feed: feedScreen, profile: profileScreen },
  structureDecisions,
  sampleDocuments: { video: sampleVideoDocument },
  queries: { feed: feedQuery, hashtag: hashtagQuery },
  aggregations: { topCreators: topCreatorsAggregation },
  indexes: { videos: videoIndexes },
} as const;
