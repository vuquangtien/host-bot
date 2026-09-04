import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from 'discord.js';

// Environment configuration types
export interface EnvConfig {
  SERVER_ID: string;
  BOT_TOKEN: string;
  VIEW_ALL_CTF_ROLEID: string;
  ACTIVE_CTF_ROLEID: string;
  VERIFIED_ROLE_ID: string;
  ADMIN_ROLE_ID: string;
  TASK_ADMIN_CHANNEL_ID: string;
  TASK_ROLE_PWN: string;
  TASK_ROLE_REV: string;
  TASK_ROLE_CRYPTO: string;
  TASK_ROLE_ALL: string;
  LOG_CHANNELID?: string;
  DENY_CTF_ROLEID?: string;
  GITHUB_TOKEN: string;
  GH_INVITE_REPO_OWNER: string;
  GH_INVITE_REPO_NAME: string;
  VERIFY_REMOVE_ROLE_ID?: string;
  VERIFY_GRANT_ROLE_ID?: string;
  VERIFY_ALLOWED_ROLE_ID?: string;
  PUBLIC_CTF_CHANNELS: boolean;
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
}

// CTF Database types
export interface CTFData {
  ctftimeid: number;
  role: string;
  cate: string;
  name: string;
  infom: string;
  channel: string;
  endtime: number;
  archived: boolean;
  channelsPurged: boolean;
  postEndOpened: boolean;
  starttime?: number;
  competitionEndtime?: number;
}

export type ChallengeSyncProvider = 'auto' | 'ctfd' | 'l3ak' | 'generic';

export interface ChallengeSyncSource {
  ctfId: number;
  url: string;
  provider: ChallengeSyncProvider;
  enabled: boolean;
  lastSyncAt?: number;
  lastError?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChallengeParserRuleFields {
  id?: string;
  name: string;
  category?: string;
  points?: string;
  description?: string;
  connectionInfo?: string;
  files?: string;
  fileName?: string;
  fileUrl?: string;
  url?: string;
}

export interface ChallengeParserRule {
  id: number;
  domain: string;
  sourceUrl: string;
  endpoint: string;
  method: 'GET';
  arrayPath: string;
  fields: ChallengeParserRuleFields;
  createdBy: string;
  failureCount: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export const CHALLENGE_CATEGORIES = ['web', 'pwn', 'crypto', 'rev', 'forensics', 'misc'] as const;

/** A normalized Discord channel slug. Includes defaults and per-CTF custom categories. */
export type ChallengeCategory = string;
export type ChallengeStatus = 'unclaimed' | 'working' | 'idea' | 'solved';

export interface CTFChallengeCategory {
  ctfId: number;
  name: ChallengeCategory;
  channelId: string;
  createdBy: string;
  createdAt: number;
}

/** Discord resources whose permissions may be maintained by the bot. */
export type ManagedDiscordChannelKind = 'category' | 'info' | 'system' | 'challenge';

export interface CTFChallenge {
  id: number;
  ctfId: number;
  threadId: string;
  channelId: string;
  name: string;
  /** Primary category inferred from the parent Discord channel. */
  category: ChallengeCategory;
  /** Primary category followed by any optional additional categories. */
  categories: ChallengeCategory[];
  points: number;
  status: ChallengeStatus;
  claimantIds: string[];
  /** Legacy single-claim field retained for migration compatibility. */
  claimedBy?: string;
  claimedAt?: number;
  solverIds: string[];
  solvedBy?: string;
  solvedAt?: number;
  writeupOwner?: string;
  writeupUrl?: string;
  externalSource?: string;
  externalId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SolvedChallenge {
  id: number;
  ctfId: number;
  threadId: string;
  challengeName: string;
  solverIds: string[];
  solvedBy: string;
  solvedAt: number;
}

export type TaskCategory = 'pwn' | 'rev' | 'crypto' | 'all';

export interface ClubTask {
  id: number;
  name: string;
  category: TaskCategory;
  requirement: string;
  threadId: string;
  channelId: string;
  roleId: string;
  createdBy: string;
  revealed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TaskSubmission {
  id: number;
  taskId: number;
  userId: string;
  username: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskSubmissionHistory {
  id: number;
  submissionId: number;
  taskId: number;
  userId: string;
  username: string;
  content: string;
  createdAt: number;
}

export type TaskWithSubmissions = ClubTask & { submissions: TaskSubmission[] };

// CTFtime API response types
export interface CTFTimeEvent {
  id: number;
  title: string;
  url: string;
  logo: string;
  weight: number;
  format: string;
  ctftime_url: string;
  description: string;
  start: string; // ISO 8601 format
  finish: string; // ISO 8601 format
  duration: {
    hours: number;
    days: number;
  };
  onsite: boolean;
  location: string;
  restrictions: string;
}

export type CTFTimeEventsResponse = CTFTimeEvent[];

// CTF Service return types
export interface CTFInfo {
  title: string;
  startTime: number;
  /** Actual competition end time. */
  endTime: number;
  /** Time at which the Discord category may be archived. */
  archiveAt: number;
  embedData: CTFEmbedData;
}

export interface CTFEmbedData {
  title: string;
  description?: string;
  url?: string;
  color: number;
  thumbnail?: string;
  image?: string;
  author?: { name: string; iconURL?: string; url?: string };
  footer?: string | { text: string; iconURL?: string };
  timestamp?: number | Date;
  fields: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
}

export interface UpcomingCTFsResult {
  embed: CTFEmbedData;
  totalPages: number;
}

export interface OngoingCTFsResult {
  embed: CTFEmbedData;
}

export interface ListCTFsResult {
  embed: CTFEmbedData;
  totalPages: number;
}

// Command types
export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

// Button interaction custom IDs
export enum ButtonAction {
  UPCO_NEXT = 'upco_next',
  UPCO_PREV = 'upco_prev',
  LIST_NEXT = 'list_next',
  LIST_PREV = 'list_prev',
  ONGO_SHOW_ALL = 'ongo_show_all',
  ONGO_HIDE_LONG = 'ongo_hide_long',
  DELETE_ALL = 'delete_all',
  DELETE_KEEP = 'delete_keep',
  DELETE_CANCEL = 'delete_cancel',
}

// Pagination data for button interactions
export interface PaginationData {
  page: number;
  step: number;
  totalPages: number;
  order?: string;
}

// Logger levels
export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
}
