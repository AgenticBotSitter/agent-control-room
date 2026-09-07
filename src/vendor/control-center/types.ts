export type IndustrySource = {
  id: string;
  name: string;
  url: string;
};

export type AiProvider = "none" | "openai" | "anthropic" | "gemini" | "xai" | "lmstudio" | "ollama";
export type AiKeyProvider = Exclude<AiProvider, "none">;
export type LocalAiProvider = Extract<AiKeyProvider, "lmstudio" | "ollama">;
export type AiModelOption = {
  id: string;
  label: string;
  /** Actual loaded capacity, never the model's theoretical maximum. */
  contextLength?: number;
};
export type AiModelsResponse = {
  provider: AiProvider;
  models: AiModelOption[];
  defaultModel: string;
  checkedAt: string;
  cached: boolean;
  localOnly: boolean;
  error?: string;
};

export type AudiencePlatform =
  | "youtube"
  | "x"
  | "instagram"
  | "facebook"
  | "linkedin"
  | "threads"
  | "tiktok";

export type AudienceAccountInput = {
  id: string;
  platform: AudiencePlatform;
  label: string;
  username: string;
  accountId: string;
  profileUrl: string;
  credential?: string;
  credentialSet?: boolean;
  clearCredential?: boolean;
};

export type PublicSettings = {
  general: {
    workspaceName: string;
  };
  industry: {
    sources: IndustrySource[];
    keywords: string[];
    description: string;
    excludedTerms: string[];
    dailyLimit: number;
  };
  mentions: {
    terms: string[];
    websites: string[];
    identityAnchors: string[];
    negativeTerms: string[];
    strictMode: boolean;
    excludeOwnedSites: boolean;
  };
  newsletters: {
    googleClientId: string;
    googleClientSecretSet: boolean;
    connected: boolean;
    connectedEmail: string;
    gmailQuery: string;
  };
  audience: {
    accounts: AudienceAccountInput[];
  };
  ai: {
    provider: AiProvider;
    model: string;
    localBaseUrls: Record<LocalAiProvider, string>;
    keySet: Record<AiKeyProvider, boolean>;
    keySource: Record<AiKeyProvider, "none" | "settings" | "environment">;
  };
  dailyBrief: {
    sourceLabels: string[];
    lookbackDays: number;
    sections: { industry: number; mentions: number; newsletters: number };
  };
};

export type SettingsUpdate = Omit<
  PublicSettings,
  "newsletters" | "audience" | "industry" | "mentions" | "ai"
> & {
  industry: Omit<PublicSettings["industry"], "description" | "excludedTerms" | "dailyLimit"> &
    Partial<Pick<PublicSettings["industry"], "description" | "excludedTerms" | "dailyLimit">>;
  mentions: Omit<PublicSettings["mentions"], "negativeTerms" | "excludeOwnedSites"> &
    Partial<Pick<PublicSettings["mentions"], "negativeTerms" | "excludeOwnedSites">>;
  newsletters: PublicSettings["newsletters"] & {
    googleClientSecret?: string;
  };
  audience: {
    accounts: AudienceAccountInput[];
  };
  ai?: {
    provider: AiProvider;
    model: string;
    localBaseUrls?: Partial<Record<LocalAiProvider, string>>;
    apiKeys?: Partial<Record<AiKeyProvider, string>>;
    clearKeys?: AiKeyProvider[];
  };
};

export type ContentWorkflow = {
  archiveReason: "user" | "expired" | "not-current";
  archivedAt?: string;
  restoreEligible: boolean;
};

export type LiveStory = {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  publishedAt: string;
  discoveredAt?: string;
  lastModifiedAt?: string;
  matchedTerm?: string;
  kind?: "feed" | "sitemap" | "topic" | "mention";
  confidence?: "high" | "medium";
  matchReasons?: string[];
  importanceScore?: number;
  importanceReason?: string;
  aiSummary?: string;
  curationMode?: "local" | AiKeyProvider;
  collectionScope?: string;
  workflow?: ContentWorkflow;
};

export type IndustrySourceStatus = {
  sourceId: string;
  source: string;
  mode: "feed" | "sitemap" | "topics";
  endpoint: string;
  state: "live" | "baseline" | "unchanged" | "changed";
  message: string;
};

export type LiveFeedResponse = {
  configured: boolean;
  checkedAt: string;
  items: LiveStory[];
  errors: string[];
  sourceStatuses?: IndustrySourceStatus[];
  filteredOut?: number;
  reviewCount?: number;
  windowDays?: number;
  providerStatuses?: Array<{
    provider: string;
    state: "live" | "degraded" | "disabled";
    message: string;
  }>;
  freshnessHours?: number;
  discoveredCount?: number;
  surfacedLimit?: number;
  curationMode?: "local" | AiKeyProvider;
  archivedItems?: LiveStory[];
  archiveCount?: number;
  historyItems?: LiveStory[];
  historyCount?: number;
};

export type NewsletterFeedResponse = {
  configured: boolean;
  connected: boolean;
  aiConfigured?: boolean;
  aiProvider?: AiKeyProvider;
  curationMode?: "local" | AiKeyProvider;
  checkedAt: string;
  items: NewsletterTopic[];
  archivedItems: NewsletterTopic[];
  archiveCount: number;
  historyItems?: NewsletterTopic[];
  historyCount?: number;
  freshnessHours?: number;
  errors: string[];
  issueCount?: number;
  mentionCount?: number;
  newsletterCount?: number;
  newIssueCount?: number;
  pendingIssueCount?: number;
};

export type AudiencePrimaryMetric = "followers" | "subscribers" | "page likes";

export type AudienceMetric = {
  id: string;
  platform: AudiencePlatform;
  label: string;
  handle: string;
  total: number | null;
  change: number | null;
  changeComparedAt?: string;
  primaryLabel?: AudiencePrimaryMetric;
  secondaryLabel?: string;
  secondaryValue?: number;
  checkedAt: string;
  error?: string;
  source?: string;
  stale?: boolean;
  lastSuccessfulAt?: string;
};

export type NewsletterItem = {
  id: string;
  sender: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  gmailUrl: string;
  workflow?: ContentWorkflow;
};

export type NewsletterSourceLink = {
  url: string;
  title: string;
  publisher: string;
};

export type NewsletterTopic = {
  id: string;
  kind: "newsletter-topic";
  title: string;
  summary: string;
  importanceScore?: number;
  importanceBaseScore?: number;
  importanceReason?: string;
  curationMode?: "local" | AiKeyProvider;
  receivedAt: string;
  url: string;
  gmailUrl: string;
  coverageCount: number;
  newsletterCount: number;
  newsletterSources: string[];
  evidenceIssueIds?: string[];
  sourceLinks: NewsletterSourceLink[];
  collectionScope: string;
  workflow?: ContentWorkflow;
};

export type ReminderItem = {
  id: string | number;
  type: string;
  title: string;
  source: string;
  note: string;
  accent: string;
  url?: string;
  createdAt?: string;
  archivedAt?: string;
  added?: string;
};

export type TaskItem = {
  id: string | number;
  title: string;
  description: string;
  due: string;
  recurrence: string;
  priority: string;
  done: boolean;
  createdAt?: string;
  completedAt?: string;
  seriesId?: string | number;
  recurrenceAnchorDay?: number;
};

export type WorkspaceState = {
  reminders: ReminderItem[];
  tasks: TaskItem[];
};

export type WorkspaceStateResponse = WorkspaceState & {
  initialized: boolean;
  legacyBrowserImportAllowed: boolean;
};

export type DailyBriefItem = {
  id: string;
  source: string;
  title: string;
  summary: string;
  kind: "action" | "meeting" | "message" | "info";
  occurredAt: string;
  dueAt?: string;
  url?: string;
  syncedAt: string;
};

export type DailyBriefResponse = {
  configured: boolean;
  checkedAt: string;
  items: DailyBriefItem[];
  snapshot?: DailyBriefSnapshotSection[];
  sourceStatuses: Array<{
    source: string;
    lastSyncedAt: string;
    lastAttemptAt: string;
    itemCount: number;
    state: "waiting" | "live" | "error";
    message: string;
  }>;
};

export type BriefCategory = "industry" | "mentions" | "newsletters";
export type DailyBriefSnapshotSection = {
  category: BriefCategory;
  requestedCount: number;
  availableCount: number;
  checkedAt: string;
  configured: boolean;
  stale: boolean;
  items: Array<{ id: string; title: string; summary: string; url: string; source: string; importanceScore?: number }>;
};
