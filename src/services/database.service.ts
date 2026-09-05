import Database from 'better-sqlite3';
import path from 'path';
import {
  ClubTask,
  CTFData,
  TaskCategory,
  TaskSubmission,
  TaskSubmissionHistory,
  TaskWithSubmissions,
  SolvedChallenge,
  CTFChallenge,
  CTFChallengeCategory,
  ChallengeParserRule,
  ChallengeParserRuleFields,
  ChallengeCategory,
  ChallengeSyncProvider,
  ChallengeSyncSource,
  ChallengeStatus,
  ManagedDiscordChannelKind,
} from '../types';
import logger from '../utils/logger';
import {
  isChallengeCategory,
  normalizeChallengeCategories,
  normalizeChallengeCategoryName,
} from '../utils/challenge-category';

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'ctf.db');

type DatabaseValue = string | number | null;

interface MetadataRow {
  value: number;
}

interface CTFRow {
  id: number;
  ctftimeid: number;
  role: string;
  cate: string;
  name: string;
  infom: string;
  channel: string;
  endtime: number;
  archived: number;
  channels_purged: number;
  post_end_opened: number;
  starttime: number;
  competition_endtime: number;
}

interface SolvedChallengeRow {
  id: number;
  ctf_id: number;
  thread_id: string;
  challenge_name: string;
  solver_ids: string;
  solved_by: string;
  solved_at: number;
}

interface ChallengeRow {
  id: number;
  ctf_id: number;
  thread_id: string;
  channel_id: string;
  name: string;
  category: string;
  categories: string | null;
  points: number;
  status: string;
  claimant_ids: string | null;
  claimed_by: string | null;
  claimed_at: number | null;
  solver_ids: string | null;
  solved_by: string | null;
  solved_at: number | null;
  writeup_owner: string | null;
  writeup_url: string | null;
  external_source: string | null;
  external_id: string | null;
  created_at: number;
  updated_at: number;
}

interface ChallengeSyncSourceRow {
  ctf_id: number;
  url: string;
  provider: ChallengeSyncProvider;
  enabled: number;
  auth_username: string | null;
  auth_password: string | null;
  auth_cookie: string | null;
  last_sync_at: number | null;
  last_error: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

const CHALLENGE_SYNC_PROVIDER_CHECK = "('auto','ctfd','l3ak','generic')";

interface ChallengeParserRuleRow {
  id: number;
  domain: string;
  source_url: string;
  endpoint: string;
  method: 'GET';
  array_path: string;
  field_mapping: string;
  created_by: string;
  failure_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface ChallengeCategoryRow {
  ctf_id: number;
  name: string;
  channel_id: string;
  created_by: string;
  created_at: number;
}

interface DashboardRow {
  channel_id: string;
  message_id: string;
}

interface TaskRow {
  id: number;
  name: string;
  category: TaskCategory;
  requirement: string;
  thread_id: string;
  channel_id: string;
  role_id: string;
  created_by: string;
  revealed: number;
  created_at: number;
  updated_at: number;
}

interface TaskSubmissionRow {
  id: number;
  task_id: number;
  user_id: string;
  username: string;
  content: string;
  created_at: number;
  updated_at: number;
}

interface TaskSubmissionHistoryRow {
  id: number;
  submission_id: number;
  task_id: number;
  user_id: string;
  username: string;
  content: string;
  created_at: number;
}

interface TableInfoRow {
  name: string;
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function normalizedRuleSourceUrl(value: string): { domain: string; sourceUrl: string } {
  const url = new URL(
    /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`
  );
  url.hash = '';
  url.searchParams.sort();
  return {
    domain: url.hostname.toLocaleLowerCase(),
    sourceUrl: url.toString(),
  };
}

/**
 * Database service for managing CTF data using SQLite3
 */
class DatabaseService {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('foreign_keys = ON');
    this.ensureDatabase();
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
    if (columns.some((existing) => existing.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private ensureChallengeSyncProviderConstraint(): void {
    const table = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('ctf_challenge_sync_sources') as { sql: string } | undefined;
    if (!table || table.sql.includes("'generic'")) return;

    this.db.exec(`
      ALTER TABLE ctf_challenge_sync_sources RENAME TO ctf_challenge_sync_sources_old;
      CREATE TABLE ctf_challenge_sync_sources (
        ctf_id INTEGER PRIMARY KEY,
        url TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ${CHALLENGE_SYNC_PROVIDER_CHECK}),
        enabled INTEGER NOT NULL DEFAULT 1,
        last_sync_at INTEGER,
        last_error TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY(ctf_id) REFERENCES ctfs(id) ON DELETE CASCADE
      );
      INSERT INTO ctf_challenge_sync_sources
        (ctf_id, url, provider, enabled, last_sync_at, last_error, created_by, created_at, updated_at)
      SELECT ctf_id, url, provider, enabled, last_sync_at, last_error, created_by, created_at, updated_at
      FROM ctf_challenge_sync_sources_old;
      DROP TABLE ctf_challenge_sync_sources_old;
    `);
  }

  /**
   * Initialize database schema if not exists
   */
  ensureDatabase(): void {
    try {
      // Create tables
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ctfs (
          id INTEGER PRIMARY KEY,
          ctftimeid INTEGER NOT NULL,
          role TEXT NOT NULL,
          cate TEXT NOT NULL,
          name TEXT NOT NULL,
          infom TEXT NOT NULL,
          channel TEXT NOT NULL,
          endtime INTEGER NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        );

        CREATE INDEX IF NOT EXISTS idx_ctftimeid ON ctfs(ctftimeid);
        CREATE INDEX IF NOT EXISTS idx_cate ON ctfs(cate);
        CREATE INDEX IF NOT EXISTS idx_archived ON ctfs(archived);
        CREATE INDEX IF NOT EXISTS idx_endtime ON ctfs(endtime);

        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN ('pwn','rev','crypto','all')),
          requirement TEXT NOT NULL,
          thread_id TEXT NOT NULL UNIQUE,
          channel_id TEXT NOT NULL,
          role_id TEXT NOT NULL,
          created_by TEXT NOT NULL,
          revealed INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s','now')),
          updated_at INTEGER DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS task_submissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER DEFAULT (strftime('%s','now')),
          updated_at INTEGER DEFAULT (strftime('%s','now')),
          UNIQUE(task_id,user_id),
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS task_submission_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          submission_id INTEGER NOT NULL,
          task_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER DEFAULT (strftime('%s','now')),
          FOREIGN KEY(submission_id) REFERENCES task_submissions(id) ON DELETE CASCADE,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);
        CREATE INDEX IF NOT EXISTS idx_tasks_revealed ON tasks(revealed);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_thread_id_unique ON tasks(thread_id);
        CREATE INDEX IF NOT EXISTS idx_task_submissions_task_id ON task_submissions(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_submission_history_submission_id ON task_submission_history(submission_id);

        CREATE TABLE IF NOT EXISTS solved_challenges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ctf_id INTEGER NOT NULL,
          thread_id TEXT NOT NULL UNIQUE,
          challenge_name TEXT NOT NULL,
          solver_ids TEXT NOT NULL,
          solved_by TEXT NOT NULL,
          solved_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          FOREIGN KEY(ctf_id) REFERENCES ctfs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_solved_challenges_ctf_id
          ON solved_challenges(ctf_id);

        CREATE TABLE IF NOT EXISTS ctf_challenges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ctf_id INTEGER NOT NULL,
          thread_id TEXT NOT NULL UNIQUE,
          channel_id TEXT NOT NULL,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          categories TEXT NOT NULL DEFAULT '[]',
          points INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'unclaimed',
          claimed_by TEXT,
          claimed_at INTEGER,
          claimant_ids TEXT NOT NULL DEFAULT '[]',
          solver_ids TEXT NOT NULL DEFAULT '[]',
          solved_by TEXT,
          solved_at INTEGER,
          writeup_owner TEXT,
          writeup_url TEXT,
          external_source TEXT,
          external_id TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          FOREIGN KEY(ctf_id) REFERENCES ctfs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ctf_challenges_ctf_id ON ctf_challenges(ctf_id);

        CREATE TABLE IF NOT EXISTS ctf_challenge_categories (
          ctf_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          channel_id TEXT NOT NULL UNIQUE,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          PRIMARY KEY(ctf_id, name),
          FOREIGN KEY(ctf_id) REFERENCES ctfs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ctf_challenge_categories_ctf_id
          ON ctf_challenge_categories(ctf_id);

        CREATE TABLE IF NOT EXISTS ctf_challenge_sync_sources (
          ctf_id INTEGER PRIMARY KEY,
          url TEXT NOT NULL,
          provider TEXT NOT NULL CHECK (provider IN ${CHALLENGE_SYNC_PROVIDER_CHECK}),
          enabled INTEGER NOT NULL DEFAULT 1,
          auth_username TEXT,
          auth_password TEXT,
          auth_cookie TEXT,
          last_sync_at INTEGER,
          last_error TEXT,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          FOREIGN KEY(ctf_id) REFERENCES ctfs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS ctf_challenge_parser_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain TEXT NOT NULL,
          source_url TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          method TEXT NOT NULL DEFAULT 'GET' CHECK (method IN ('GET')),
          array_path TEXT NOT NULL DEFAULT '',
          field_mapping TEXT NOT NULL,
          created_by TEXT NOT NULL,
          failure_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          UNIQUE(domain, source_url)
        );
        CREATE INDEX IF NOT EXISTS idx_ctf_challenge_parser_rules_domain
          ON ctf_challenge_parser_rules(domain);

        CREATE TABLE IF NOT EXISTS ctf_dashboards (
          ctf_id INTEGER PRIMARY KEY,
          channel_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          FOREIGN KEY(ctf_id) REFERENCES ctfs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS ctf_reminders (
          ctf_id INTEGER NOT NULL,
          milestone TEXT NOT NULL,
          sent_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          PRIMARY KEY(ctf_id, milestone),
          FOREIGN KEY(ctf_id) REFERENCES ctfs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS bot_managed_discord_channels (
          channel_id TEXT PRIMARY KEY,
          parent_category_id TEXT,
          kind TEXT NOT NULL CHECK (kind IN ('category','info','system','challenge')),
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_bot_managed_discord_channels_parent
          ON bot_managed_discord_channels(parent_category_id);
      `);

      this.addColumnIfMissing('ctfs', 'channels_purged', 'INTEGER NOT NULL DEFAULT 0');
      this.addColumnIfMissing('ctfs', 'post_end_opened', 'INTEGER NOT NULL DEFAULT 0');
      this.addColumnIfMissing('ctfs', 'starttime', 'INTEGER NOT NULL DEFAULT 0');
      this.addColumnIfMissing('ctfs', 'competition_endtime', 'INTEGER NOT NULL DEFAULT 0');
      this.addColumnIfMissing('ctf_challenges', 'claimed_at', 'INTEGER');
      this.addColumnIfMissing('ctf_challenges', 'claimant_ids', "TEXT NOT NULL DEFAULT '[]'");
      this.addColumnIfMissing('ctf_challenges', 'categories', "TEXT NOT NULL DEFAULT '[]'");
      this.addColumnIfMissing('ctf_challenges', 'external_source', 'TEXT');
      this.addColumnIfMissing('ctf_challenges', 'external_id', 'TEXT');
      this.ensureChallengeSyncProviderConstraint();
      this.addColumnIfMissing('ctf_challenge_sync_sources', 'auth_username', 'TEXT');
      this.addColumnIfMissing('ctf_challenge_sync_sources', 'auth_password', 'TEXT');
      this.addColumnIfMissing('ctf_challenge_sync_sources', 'auth_cookie', 'TEXT');
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ctf_challenges_external
          ON ctf_challenges(ctf_id, external_source, external_id)
          WHERE external_source IS NOT NULL AND external_id IS NOT NULL
      `);
      this.db.exec(`
        UPDATE ctfs
        SET competition_endtime = CASE
          WHEN ctftimeid != 0 AND endtime > 604800 THEN endtime - 604800
          ELSE endtime
        END
        WHERE competition_endtime = 0 AND endtime > 0
      `);
      this.db.exec(`
        UPDATE ctf_challenges
        SET claimant_ids = json_array(claimed_by)
        WHERE claimed_by IS NOT NULL
          AND claimed_by != ''
          AND (claimant_ids IS NULL OR claimant_ids = '[]')
      `);
      this.db.exec(`
        UPDATE ctf_challenges
        SET categories = json_array(category)
        WHERE categories IS NULL OR categories = '' OR categories = '[]'
      `);

      // Initialize counter if not exists
      const counter = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('counter') as
        MetadataRow | undefined;
      if (!counter) {
        this.db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('counter', 0);
        logger.info('Database initialized with counter = 0');
      }

      logger.debug('Database schema ensured');
    } catch (error) {
      logger.error('Failed to ensure database schema:', error);
      throw new Error('Database initialization error');
    }
  }

  /**
   * Find CTF by internal database key
   */
  async findByKey(key: string): Promise<{ key: string; data: CTFData } | null> {
    try {
      const id = parseInt(key, 10);
      if (!Number.isInteger(id)) return null;

      const row = this.db.prepare('SELECT * FROM ctfs WHERE id = ?').get(id) as CTFRow | undefined;
      if (!row) return null;
      return { key: row.id.toString(), data: this.rowToCTFData(row) };
    } catch (error) {
      logger.error('Failed to find CTF by key:', error);
      return null;
    }
  }

  /**
   * Find CTF by CTFtime ID
   */
  async findByCTFTimeId(ctftimeId: number): Promise<{ key: string; data: CTFData } | null> {
    try {
      const row = this.db.prepare('SELECT * FROM ctfs WHERE ctftimeid = ?').get(ctftimeId) as
        CTFRow | undefined;

      if (!row) return null;

      return {
        key: row.id.toString(),
        data: this.rowToCTFData(row),
      };
    } catch (error) {
      logger.error('Failed to find CTF by CTFtime ID:', error);
      return null;
    }
  }

  /**
   * Find CTF by Discord role ID
   */
  async findByRoleId(roleId: string): Promise<{ key: string; data: CTFData } | null> {
    try {
      const row = this.db.prepare('SELECT * FROM ctfs WHERE role = ?').get(roleId) as
        CTFRow | undefined;
      if (!row) return null;
      return { key: row.id.toString(), data: this.rowToCTFData(row) };
    } catch (error) {
      logger.error('Failed to find CTF by role ID:', error);
      return null;
    }
  }

  /**
   * Find CTF by category ID
   */
  async findByCategoryId(categoryId: string): Promise<{ key: string; data: CTFData } | null> {
    try {
      const row = this.db.prepare('SELECT * FROM ctfs WHERE cate = ?').get(categoryId) as
        CTFRow | undefined;

      if (!row) return null;

      return {
        key: row.id.toString(),
        data: this.rowToCTFData(row),
      };
    } catch (error) {
      logger.error('Failed to find CTF by category ID:', error);
      return null;
    }
  }

  /**
   * Add new CTF to database
   */
  async addCTF(
    ctfData: Omit<CTFData, 'archived' | 'channelsPurged' | 'postEndOpened'>
  ): Promise<number> {
    try {
      // Get and increment counter
      const counter = this.db
        .prepare('SELECT value FROM metadata WHERE key = ?')
        .get('counter') as MetadataRow;
      const newId = counter.value + 1;

      // Update counter
      this.db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(newId, 'counter');

      // Insert CTF
      this.db
        .prepare(
          `INSERT INTO ctfs (id, ctftimeid, role, cate, name, infom, channel, endtime, archived, starttime, competition_endtime)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          newId,
          ctfData.ctftimeid,
          ctfData.role.toString(),
          ctfData.cate.toString(),
          ctfData.name,
          ctfData.infom.toString(),
          ctfData.channel.toString(),
          ctfData.endtime,
          0,
          ctfData.starttime ?? 0,
          ctfData.competitionEndtime ?? 0
        );

      logger.info(`CTF added to database: ${ctfData.name} (ID: ${newId})`);
      return newId;
    } catch (error) {
      logger.error('Failed to add CTF:', error);
      throw new Error('Database write error');
    }
  }

  /**
   * Update CTF data
   */
  async updateCTF(key: string, updates: Partial<CTFData>): Promise<void> {
    try {
      const id = parseInt(key);
      const setClauses: string[] = [];
      const values: DatabaseValue[] = [];

      if (updates.ctftimeid !== undefined) {
        setClauses.push('ctftimeid = ?');
        values.push(updates.ctftimeid);
      }
      if (updates.role !== undefined) {
        setClauses.push('role = ?');
        values.push(updates.role.toString());
      }
      if (updates.cate !== undefined) {
        setClauses.push('cate = ?');
        values.push(updates.cate.toString());
      }
      if (updates.name !== undefined) {
        setClauses.push('name = ?');
        values.push(updates.name);
      }
      if (updates.infom !== undefined) {
        setClauses.push('infom = ?');
        values.push(updates.infom.toString());
      }
      if (updates.channel !== undefined) {
        setClauses.push('channel = ?');
        values.push(updates.channel.toString());
      }
      if (updates.endtime !== undefined) {
        setClauses.push('endtime = ?');
        values.push(updates.endtime);
      }
      if (updates.archived !== undefined) {
        setClauses.push('archived = ?');
        values.push(updates.archived ? 1 : 0);
      }
      if (updates.channelsPurged !== undefined) {
        setClauses.push('channels_purged = ?');
        values.push(updates.channelsPurged ? 1 : 0);
      }
      if (updates.postEndOpened !== undefined) {
        setClauses.push('post_end_opened = ?');
        values.push(updates.postEndOpened ? 1 : 0);
      }
      if (updates.starttime !== undefined) {
        setClauses.push('starttime = ?');
        values.push(updates.starttime);
      }
      if (updates.competitionEndtime !== undefined) {
        setClauses.push('competition_endtime = ?');
        values.push(updates.competitionEndtime);
      }

      setClauses.push("updated_at = strftime('%s', 'now')");
      values.push(id);

      const sql = `UPDATE ctfs SET ${setClauses.join(', ')} WHERE id = ?`;
      const result = this.db.prepare(sql).run(...values);

      if (result.changes === 0) {
        throw new Error(`CTF with key ${key} not found`);
      }

      logger.info(`CTF updated in database: ${key}`);
    } catch (error) {
      logger.error('Failed to update CTF:', error);
      throw error;
    }
  }

  /**
   * Replace a CTF schedule and clear persisted milestones atomically.
   * This allows reminders, including `started`, to be delivered again for the corrected schedule.
   */
  async updateCTFSchedule(
    key: string,
    schedule: { startTime: number; endTime: number; archiveAt: number }
  ): Promise<void> {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`Invalid CTF key: ${key}`);
    }

    try {
      const transaction = this.db.transaction(() => {
        const result = this.db
          .prepare(
            `UPDATE ctfs
             SET starttime = ?, competition_endtime = ?, endtime = ?,
                 post_end_opened = 0, updated_at = strftime('%s', 'now')
             WHERE id = ?`
          )
          .run(schedule.startTime, schedule.endTime, schedule.archiveAt, id);

        if (result.changes === 0) {
          throw new Error(`CTF with key ${key} not found`);
        }

        this.db.prepare('DELETE FROM ctf_reminders WHERE ctf_id = ?').run(id);
      });

      transaction();
      logger.info(`CTF schedule updated and reminders reset: ${key}`);
    } catch (error) {
      logger.error('Failed to update CTF schedule:', error);
      throw error;
    }
  }

  /**
   * Delete CTF from database
   */
  async deleteCTF(key: string): Promise<CTFData> {
    try {
      const id = parseInt(key);

      // Get the CTF data before deleting
      const row = this.db.prepare('SELECT * FROM ctfs WHERE id = ?').get(id) as CTFRow | undefined;

      if (!row) {
        throw new Error(`CTF with key ${key} not found`);
      }

      // Delete the CTF
      this.db.prepare('DELETE FROM ctfs WHERE id = ?').run(id);

      const deletedData = this.rowToCTFData(row);
      logger.info(`CTF deleted from database: ${deletedData.name}`);

      return deletedData;
    } catch (error) {
      logger.error('Failed to delete CTF:', error);
      throw error;
    }
  }

  /**
   * Get all CTFs sorted by index
   */
  async getAllCTFs(
    order: 'oldest' | 'newest' = 'newest'
  ): Promise<Array<{ key: string; data: CTFData }>> {
    try {
      const orderBy = order === 'newest' ? 'DESC' : 'ASC';
      const rows = this.db.prepare(`SELECT * FROM ctfs ORDER BY id ${orderBy}`).all() as CTFRow[];

      return rows.map((row) => ({
        key: row.id.toString(),
        data: this.rowToCTFData(row),
      }));
    } catch (error) {
      logger.error('Failed to get all CTFs:', error);
      return [];
    }
  }

  /**
   * Get archived CTFs that need to be hidden
   */
  async getExpiredCTFs(currentTime: number): Promise<Array<{ key: string; data: CTFData }>> {
    try {
      const rows = this.db
        .prepare('SELECT * FROM ctfs WHERE archived = 0 AND endtime < ?')
        .all(currentTime) as CTFRow[];

      return rows.map((row) => ({
        key: row.id.toString(),
        data: this.rowToCTFData(row),
      }));
    } catch (error) {
      logger.error('Failed to get expired CTFs:', error);
      return [];
    }
  }

  /**
   * Get database statistics
   */
  async getStats(): Promise<{
    totalCTFs: number;
    archivedCTFs: number;
    activeCTFs: number;
    counter: number;
  }> {
    try {
      const total = this.db.prepare('SELECT COUNT(*) as count FROM ctfs').get() as {
        count: number;
      };
      const archived = this.db
        .prepare('SELECT COUNT(*) as count FROM ctfs WHERE archived = 1')
        .get() as {
        count: number;
      };
      const counter = this.db
        .prepare('SELECT value FROM metadata WHERE key = ?')
        .get('counter') as {
        value: number;
      };

      return {
        totalCTFs: total.count,
        archivedCTFs: archived.count,
        activeCTFs: total.count - archived.count,
        counter: counter.value,
      };
    } catch (error) {
      logger.error('Failed to get database stats:', error);
      return { totalCTFs: 0, archivedCTFs: 0, activeCTFs: 0, counter: 0 };
    }
  }

  async markAsPurged(key: string): Promise<void> {
    const id = parseInt(key);
    this.db
      .prepare(
        "UPDATE ctfs SET channels_purged = 1, updated_at = strftime('%s', 'now') WHERE id = ?"
      )
      .run(id);
    logger.info(`CTF marked as purged: ${key}`);
  }

  async upsertSolvedChallenge(input: {
    ctfId: number;
    threadId: string;
    challengeName: string;
    solverIds: string[];
    solvedBy: string;
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO solved_challenges
        (ctf_id, thread_id, challenge_name, solver_ids, solved_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         ctf_id = excluded.ctf_id,
         challenge_name = excluded.challenge_name,
         solver_ids = excluded.solver_ids,
         solved_by = excluded.solved_by,
         solved_at = strftime('%s','now')`
      )
      .run(
        input.ctfId,
        input.threadId,
        input.challengeName,
        JSON.stringify(input.solverIds),
        input.solvedBy
      );
  }

  async solveChallenge(input: {
    challengeId: number;
    recordedBy: string;
    solvedAt: number;
  }): Promise<CTFChallenge> {
    const transaction = this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT * FROM ctf_challenges WHERE id = ?')
        .get(input.challengeId) as ChallengeRow | undefined;
      if (!current) throw new Error('Challenge not found');
      if (current.status === 'solved') throw new Error('Challenge already solved');

      this.db
        .prepare(
          `UPDATE ctf_challenges
           SET status = 'solved', solver_ids = '[]', solved_by = ?, solved_at = ?,
               claimed_by = NULL, updated_at = strftime('%s','now')
           WHERE id = ?`
        )
        .run(input.recordedBy, input.solvedAt, input.challengeId);

      this.db
        .prepare(
          `INSERT INTO solved_challenges
            (ctf_id, thread_id, challenge_name, solver_ids, solved_by, solved_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             ctf_id = excluded.ctf_id,
             challenge_name = excluded.challenge_name,
             solver_ids = excluded.solver_ids,
             solved_by = excluded.solved_by,
             solved_at = excluded.solved_at`
        )
        .run(
          current.ctf_id,
          current.thread_id,
          current.name,
          '[]',
          input.recordedBy,
          input.solvedAt
        );

      const updated = this.db
        .prepare('SELECT * FROM ctf_challenges WHERE id = ?')
        .get(input.challengeId) as ChallengeRow | undefined;
      if (!updated) throw new Error('Updated challenge not found');
      return updated;
    });

    return this.rowToChallenge(transaction());
  }

  async undoChallengeSolve(challengeId: number): Promise<CTFChallenge> {
    const transaction = this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT * FROM ctf_challenges WHERE id = ?')
        .get(challengeId) as ChallengeRow | undefined;
      if (!current) throw new Error('Challenge not found');

      const hasClaimants = parseStringArray(current.claimant_ids).length > 0;
      this.db
        .prepare(
          `UPDATE ctf_challenges
           SET status = ?, claimed_at = ?, solver_ids = '[]', solved_by = NULL,
               solved_at = NULL, writeup_owner = NULL, writeup_url = NULL,
               updated_at = strftime('%s','now')
           WHERE id = ?`
        )
        .run(
          hasClaimants ? 'working' : 'unclaimed',
          hasClaimants ? (current.claimed_at ?? Math.floor(Date.now() / 1000)) : null,
          challengeId
        );
      this.db.prepare('DELETE FROM solved_challenges WHERE thread_id = ?').run(current.thread_id);

      const updated = this.db
        .prepare('SELECT * FROM ctf_challenges WHERE id = ?')
        .get(challengeId) as ChallengeRow | undefined;
      if (!updated) throw new Error('Updated challenge not found');
      return updated;
    });

    return this.rowToChallenge(transaction());
  }

  async getSolvedChallenges(ctfId: number): Promise<SolvedChallenge[]> {
    const rows = this.db
      .prepare('SELECT * FROM solved_challenges WHERE ctf_id = ? ORDER BY solved_at ASC, id ASC')
      .all(ctfId) as SolvedChallengeRow[];

    return rows.map((row) => ({
      id: row.id,
      ctfId: row.ctf_id,
      threadId: row.thread_id,
      challengeName: row.challenge_name,
      solverIds: parseStringArray(row.solver_ids),
      solvedBy: row.solved_by,
      solvedAt: row.solved_at,
    }));
  }

  async createChallenge(input: {
    ctfId: number;
    threadId: string;
    channelId: string;
    name: string;
    category: ChallengeCategory;
    categories?: ChallengeCategory[];
    points: number;
    externalSource?: string;
    externalId?: string;
  }): Promise<CTFChallenge> {
    const categories = normalizeChallengeCategories(input.category, input.categories);
    const result = this.db
      .prepare(
        `INSERT INTO ctf_challenges
          (ctf_id,thread_id,channel_id,name,category,categories,points,external_source,external_id)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        input.ctfId,
        input.threadId,
        input.channelId,
        input.name,
        input.category,
        JSON.stringify(categories),
        input.points,
        input.externalSource ?? null,
        input.externalId ?? null
      );
    const challenge = await this.getChallengeById(Number(result.lastInsertRowid));
    if (!challenge) throw new Error('Inserted challenge not found');
    return challenge;
  }

  async registerChallengeCategory(input: {
    ctfId: number;
    name: ChallengeCategory;
    channelId: string;
    createdBy: string;
  }): Promise<CTFChallengeCategory> {
    const normalizedName = normalizeChallengeCategoryName(input.name);
    if (!normalizedName || normalizedName !== input.name) {
      throw new Error('Challenge category name must be a normalized channel slug');
    }

    this.db
      .prepare(
        `INSERT INTO ctf_challenge_categories (ctf_id, name, channel_id, created_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(ctf_id, name) DO UPDATE SET
           channel_id = excluded.channel_id,
           created_by = excluded.created_by`
      )
      .run(input.ctfId, normalizedName, input.channelId, input.createdBy);

    const category = await this.findChallengeCategoryByName(input.ctfId, normalizedName);
    if (!category) throw new Error('Registered challenge category not found');
    return category;
  }

  /**
   * Persist explicit ownership before the bot is allowed to edit channel permissions.
   * Existing Discord resources are never inserted automatically.
   */
  async registerManagedDiscordChannel(input: {
    channelId: string;
    parentCategoryId?: string;
    kind: ManagedDiscordChannelKind;
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO bot_managed_discord_channels (channel_id, parent_category_id, kind)
         VALUES (?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           parent_category_id = excluded.parent_category_id,
           kind = excluded.kind`
      )
      .run(input.channelId, input.parentCategoryId ?? null, input.kind);
  }

  async isManagedDiscordChannel(channelId: string): Promise<boolean> {
    const row = this.db
      .prepare('SELECT 1 AS found FROM bot_managed_discord_channels WHERE channel_id = ?')
      .get(channelId) as { found: number } | undefined;
    return row?.found === 1;
  }

  async getManagedDiscordChannelIds(parentCategoryId: string): Promise<Set<string>> {
    const rows = this.db
      .prepare('SELECT channel_id FROM bot_managed_discord_channels WHERE parent_category_id = ?')
      .all(parentCategoryId) as Array<{ channel_id: string }>;
    return new Set(rows.map((row) => row.channel_id));
  }

  async removeManagedDiscordChannel(channelId: string): Promise<void> {
    this.db.prepare('DELETE FROM bot_managed_discord_channels WHERE channel_id = ?').run(channelId);
  }

  async removeManagedDiscordCategory(categoryId: string): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM bot_managed_discord_channels
         WHERE channel_id = ? OR parent_category_id = ?`
      )
      .run(categoryId, categoryId);
  }

  async getChallengeCategories(ctfId: number): Promise<CTFChallengeCategory[]> {
    const rows = this.db
      .prepare('SELECT * FROM ctf_challenge_categories WHERE ctf_id = ? ORDER BY name')
      .all(ctfId) as ChallengeCategoryRow[];
    return rows.map((row) => this.rowToChallengeCategory(row));
  }

  async findChallengeCategoryByName(
    ctfId: number,
    name: string
  ): Promise<CTFChallengeCategory | null> {
    const row = this.db
      .prepare('SELECT * FROM ctf_challenge_categories WHERE ctf_id = ? AND name = ?')
      .get(ctfId, name) as ChallengeCategoryRow | undefined;
    return row ? this.rowToChallengeCategory(row) : null;
  }

  async findChallengeCategoryByChannel(channelId: string): Promise<CTFChallengeCategory | null> {
    const row = this.db
      .prepare('SELECT * FROM ctf_challenge_categories WHERE channel_id = ?')
      .get(channelId) as ChallengeCategoryRow | undefined;
    return row ? this.rowToChallengeCategory(row) : null;
  }

  async upsertChallengeSyncSource(input: {
    ctfId: number;
    url: string;
    provider: ChallengeSyncProvider;
    enabled?: boolean;
    authUsername?: string | null;
    authPassword?: string | null;
    authCookie?: string | null;
    createdBy: string;
  }): Promise<ChallengeSyncSource> {
    const normalizedUrl = input.url.trim();
    if (!normalizedUrl) throw new Error('Challenge sync URL cannot be empty');
    const authUsername = input.authUsername?.trim() || null;
    const authPassword = input.authPassword || null;
    const authCookie = input.authCookie?.trim() || null;

    this.db
      .prepare(
        `INSERT INTO ctf_challenge_sync_sources
          (ctf_id, url, provider, enabled, auth_username, auth_password, auth_cookie, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ctf_id) DO UPDATE SET
           url = excluded.url,
           provider = excluded.provider,
           enabled = excluded.enabled,
           auth_username = COALESCE(excluded.auth_username, auth_username),
           auth_password = COALESCE(excluded.auth_password, auth_password),
           auth_cookie = COALESCE(excluded.auth_cookie, auth_cookie),
           last_error = NULL,
           updated_at = strftime('%s','now')`
      )
      .run(
        input.ctfId,
        normalizedUrl,
        input.provider,
        input.enabled === false ? 0 : 1,
        authUsername,
        authPassword,
        authCookie,
        input.createdBy
      );

    const source = await this.getChallengeSyncSource(input.ctfId);
    if (!source) throw new Error('Challenge sync source was not saved');
    return source;
  }

  async getChallengeSyncSource(ctfId: number): Promise<ChallengeSyncSource | null> {
    const row = this.db
      .prepare('SELECT * FROM ctf_challenge_sync_sources WHERE ctf_id = ?')
      .get(ctfId) as ChallengeSyncSourceRow | undefined;
    return row ? this.rowToChallengeSyncSource(row) : null;
  }

  async getEnabledChallengeSyncSources(): Promise<ChallengeSyncSource[]> {
    const rows = this.db
      .prepare(
        `SELECT source.*
         FROM ctf_challenge_sync_sources source
         JOIN ctfs ON ctfs.id = source.ctf_id
         WHERE source.enabled = 1
           AND ctfs.archived = 0
           AND ctfs.channels_purged = 0
         ORDER BY source.updated_at ASC, source.ctf_id ASC`
      )
      .all() as ChallengeSyncSourceRow[];
    return rows.map((row) => this.rowToChallengeSyncSource(row));
  }

  async markChallengeSyncResult(
    ctfId: number,
    result: { ok: true; syncedAt: number } | { ok: false; error: string }
  ): Promise<void> {
    if (result.ok) {
      this.db
        .prepare(
          `UPDATE ctf_challenge_sync_sources
           SET last_sync_at = ?, last_error = NULL, updated_at = strftime('%s','now')
           WHERE ctf_id = ?`
        )
        .run(result.syncedAt, ctfId);
      return;
    }

    this.db
      .prepare(
        `UPDATE ctf_challenge_sync_sources
         SET last_error = ?, updated_at = strftime('%s','now')
         WHERE ctf_id = ?`
      )
      .run(result.error.slice(0, 500), ctfId);
  }

  async getChallengeParserRule(sourceUrl: string): Promise<ChallengeParserRule | null> {
    const normalized = normalizedRuleSourceUrl(sourceUrl);
    const row = this.db
      .prepare(
        `SELECT * FROM ctf_challenge_parser_rules
         WHERE domain = ? AND source_url = ?`
      )
      .get(normalized.domain, normalized.sourceUrl) as ChallengeParserRuleRow | undefined;
    return row ? this.rowToChallengeParserRule(row) : null;
  }

  async upsertChallengeParserRule(input: {
    sourceUrl: string;
    endpoint: string;
    arrayPath: string;
    fields: ChallengeParserRuleFields;
    createdBy: string;
  }): Promise<ChallengeParserRule> {
    const normalized = normalizedRuleSourceUrl(input.sourceUrl);
    this.db
      .prepare(
        `INSERT INTO ctf_challenge_parser_rules
           (domain, source_url, endpoint, method, array_path, field_mapping, created_by)
         VALUES (?, ?, ?, 'GET', ?, ?, ?)
         ON CONFLICT(domain, source_url) DO UPDATE SET
           endpoint = excluded.endpoint,
           method = excluded.method,
           array_path = excluded.array_path,
           field_mapping = excluded.field_mapping,
           failure_count = 0,
           last_error = NULL,
           updated_at = strftime('%s','now')`
      )
      .run(
        normalized.domain,
        normalized.sourceUrl,
        input.endpoint,
        input.arrayPath,
        JSON.stringify(input.fields),
        input.createdBy
      );

    const rule = await this.getChallengeParserRule(input.sourceUrl);
    if (!rule) throw new Error('Challenge parser rule was not saved');
    return rule;
  }

  async markChallengeParserRuleResult(
    ruleId: number,
    result: { ok: true } | { ok: false; error: string }
  ): Promise<void> {
    if (result.ok) {
      this.db
        .prepare(
          `UPDATE ctf_challenge_parser_rules
           SET failure_count = 0, last_error = NULL, updated_at = strftime('%s','now')
           WHERE id = ?`
        )
        .run(ruleId);
      return;
    }

    this.db
      .prepare(
        `UPDATE ctf_challenge_parser_rules
         SET failure_count = failure_count + 1,
             last_error = ?,
             updated_at = strftime('%s','now')
         WHERE id = ?`
      )
      .run(result.error.slice(0, 500), ruleId);
  }

  async getChallengeById(id: number): Promise<CTFChallenge | null> {
    const row = this.db.prepare('SELECT * FROM ctf_challenges WHERE id = ?').get(id) as
      ChallengeRow | undefined;
    return row ? this.rowToChallenge(row) : null;
  }

  async getChallengeByThread(threadId: string): Promise<CTFChallenge | null> {
    const row = this.db
      .prepare('SELECT * FROM ctf_challenges WHERE thread_id = ?')
      .get(threadId) as ChallengeRow | undefined;
    return row ? this.rowToChallenge(row) : null;
  }

  async getChallengeByExternalId(
    ctfId: number,
    externalSource: string,
    externalId: string
  ): Promise<CTFChallenge | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM ctf_challenges
         WHERE ctf_id = ? AND external_source = ? AND external_id = ?`
      )
      .get(ctfId, externalSource, externalId) as ChallengeRow | undefined;
    return row ? this.rowToChallenge(row) : null;
  }

  async getChallengesByCTF(ctfId: number): Promise<CTFChallenge[]> {
    const rows = this.db
      .prepare('SELECT * FROM ctf_challenges WHERE ctf_id = ? ORDER BY category,name')
      .all(ctfId) as ChallengeRow[];
    return rows.map((row) => this.rowToChallenge(row));
  }

  async updateChallenge(
    id: number,
    updates: Partial<
      Pick<
        CTFChallenge,
        | 'status'
        | 'claimantIds'
        | 'claimedBy'
        | 'claimedAt'
        | 'points'
        | 'solverIds'
        | 'solvedBy'
        | 'solvedAt'
        | 'writeupOwner'
        | 'writeupUrl'
        | 'externalSource'
        | 'externalId'
      >
    >
  ): Promise<CTFChallenge> {
    const sets: string[] = [];
    const values: DatabaseValue[] = [];
    const add = (column: string, value: DatabaseValue): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };

    if ('status' in updates) add('status', updates.status ?? null);
    if ('claimantIds' in updates) {
      add('claimant_ids', JSON.stringify(updates.claimantIds ?? []));
    }
    if ('claimedBy' in updates) add('claimed_by', updates.claimedBy ?? null);
    if ('claimedAt' in updates) add('claimed_at', updates.claimedAt ?? null);
    if ('points' in updates) add('points', updates.points ?? 0);
    if ('solverIds' in updates) add('solver_ids', JSON.stringify(updates.solverIds ?? []));
    if ('solvedBy' in updates) add('solved_by', updates.solvedBy ?? null);
    if ('solvedAt' in updates) add('solved_at', updates.solvedAt ?? null);
    if ('writeupOwner' in updates) add('writeup_owner', updates.writeupOwner ?? null);
    if ('writeupUrl' in updates) add('writeup_url', updates.writeupUrl ?? null);
    if ('externalSource' in updates) add('external_source', updates.externalSource ?? null);
    if ('externalId' in updates) add('external_id', updates.externalId ?? null);

    sets.push("updated_at = strftime('%s','now')");
    values.push(id);
    this.db.prepare(`UPDATE ctf_challenges SET ${sets.join(',')} WHERE id = ?`).run(...values);

    const challenge = await this.getChallengeById(id);
    if (!challenge) throw new Error('Challenge not found');
    return challenge;
  }

  async claimChallengeWriteup(
    id: number,
    userId: string
  ): Promise<{ challenge: CTFChallenge; added: boolean }> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM ctf_challenges WHERE id = ?').get(id) as
        ChallengeRow | undefined;
      if (!row) throw new Error('Challenge not found');
      if (row.status !== 'solved') throw new Error('Challenge must be solved before writeup claim');

      if (row.writeup_url || row.writeup_owner) {
        return { challenge: this.rowToChallenge(row), added: false };
      }

      this.db
        .prepare(
          `UPDATE ctf_challenges
           SET writeup_owner = ?, updated_at = strftime('%s','now')
           WHERE id = ?`
        )
        .run(userId, id);

      const updated = this.db.prepare('SELECT * FROM ctf_challenges WHERE id = ?').get(id) as
        ChallengeRow | undefined;
      if (!updated) throw new Error('Updated challenge not found');
      return { challenge: this.rowToChallenge(updated), added: true };
    });

    return transaction();
  }

  async releaseChallengeWriteup(
    id: number,
    userId: string,
    allowOverride = false
  ): Promise<{ challenge: CTFChallenge; released: boolean }> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM ctf_challenges WHERE id = ?').get(id) as
        ChallengeRow | undefined;
      if (!row) throw new Error('Challenge not found');
      if (row.status !== 'solved')
        throw new Error('Challenge must be solved before writeup release');

      if (row.writeup_url || !row.writeup_owner) {
        return { challenge: this.rowToChallenge(row), released: false };
      }
      if (row.writeup_owner !== userId && !allowOverride) {
        return { challenge: this.rowToChallenge(row), released: false };
      }

      this.db
        .prepare(
          `UPDATE ctf_challenges
           SET writeup_owner = NULL, updated_at = strftime('%s','now')
           WHERE id = ?`
        )
        .run(id);

      const updated = this.db.prepare('SELECT * FROM ctf_challenges WHERE id = ?').get(id) as
        ChallengeRow | undefined;
      if (!updated) throw new Error('Updated challenge not found');
      return { challenge: this.rowToChallenge(updated), released: true };
    });

    return transaction();
  }

  async addChallengeClaimant(
    id: number,
    userId: string
  ): Promise<{ challenge: CTFChallenge; added: boolean }> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM ctf_challenges WHERE id = ?').get(id) as
        ChallengeRow | undefined;
      if (!row) throw new Error('Challenge not found');
      const claimantIds = parseStringArray(row.claimant_ids);
      if (claimantIds.includes(userId))
        return { challenge: this.rowToChallenge(row), added: false };
      claimantIds.push(userId);
      this.db
        .prepare(
          `UPDATE ctf_challenges SET claimant_ids = ?, claimed_at = COALESCE(claimed_at, strftime('%s','now')), status = CASE WHEN status = 'unclaimed' THEN 'working' ELSE status END, updated_at = strftime('%s','now') WHERE id = ?`
        )
        .run(JSON.stringify(claimantIds), id);
      const updated = this.db.prepare('SELECT * FROM ctf_challenges WHERE id = ?').get(id) as
        ChallengeRow | undefined;
      if (!updated) throw new Error('Updated challenge not found');
      return { challenge: this.rowToChallenge(updated), added: true };
    });
    return transaction();
  }

  async removeChallengeClaimant(
    id: number,
    userId: string
  ): Promise<{ challenge: CTFChallenge; removed: boolean }> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM ctf_challenges WHERE id = ?').get(id) as
        ChallengeRow | undefined;
      if (!row) throw new Error('Challenge not found');
      const claimantIds = parseStringArray(row.claimant_ids);
      const next = claimantIds.filter((id) => id !== userId);
      if (next.length === claimantIds.length)
        return { challenge: this.rowToChallenge(row), removed: false };
      this.db
        .prepare(
          `UPDATE ctf_challenges SET claimant_ids = ?, claimed_at = CASE WHEN ? = 0 THEN NULL ELSE claimed_at END, status = CASE WHEN ? = 0 AND status != 'solved' THEN 'unclaimed' ELSE status END, updated_at = strftime('%s','now') WHERE id = ?`
        )
        .run(JSON.stringify(next), next.length, next.length, id);
      const updated = this.db.prepare('SELECT * FROM ctf_challenges WHERE id = ?').get(id) as
        ChallengeRow | undefined;
      if (!updated) throw new Error('Updated challenge not found');
      return { challenge: this.rowToChallenge(updated), removed: true };
    });
    return transaction();
  }

  async deleteChallengeByThread(threadId: string): Promise<void> {
    this.db.prepare('DELETE FROM ctf_challenges WHERE thread_id = ?').run(threadId);
  }
  async deleteChallengeSolveRecord(threadId: string): Promise<void> {
    this.db.prepare('DELETE FROM solved_challenges WHERE thread_id = ?').run(threadId);
  }

  async getDashboard(ctfId: number): Promise<{ channelId: string; messageId: string } | null> {
    const row = this.db
      .prepare('SELECT channel_id,message_id FROM ctf_dashboards WHERE ctf_id=?')
      .get(ctfId) as DashboardRow | undefined;
    return row ? { channelId: row.channel_id, messageId: row.message_id } : null;
  }

  async setDashboard(ctfId: number, channelId: string, messageId: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO ctf_dashboards(ctf_id,channel_id,message_id) VALUES(?,?,?) ON CONFLICT(ctf_id) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id,updated_at=strftime('%s','now')`
      )
      .run(ctfId, channelId, messageId);
  }

  async markReminderSent(ctfId: number, milestone: string): Promise<boolean> {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO ctf_reminders(ctf_id,milestone) VALUES(?,?)')
        .run(ctfId, milestone).changes > 0
    );
  }

  async removeReminder(ctfId: number, milestone: string): Promise<void> {
    this.db
      .prepare('DELETE FROM ctf_reminders WHERE ctf_id = ? AND milestone = ?')
      .run(ctfId, milestone);
  }

  async createTask(input: {
    name: string;
    category: TaskCategory;
    requirement: string;
    threadId: string;
    channelId: string;
    roleId: string;
    createdBy: string;
  }): Promise<ClubTask> {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO tasks (name, category, requirement, thread_id, channel_id, role_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.name,
          input.category,
          input.requirement,
          input.threadId,
          input.channelId,
          input.roleId,
          input.createdBy
        );
      const row = this.db
        .prepare('SELECT * FROM tasks WHERE id = ?')
        .get(result.lastInsertRowid) as TaskRow | undefined;
      if (!row) throw new Error('Inserted task not found');
      logger.info(`Task added to database: ${input.name} (ID: ${result.lastInsertRowid})`);
      return this.rowToTask(row);
    } catch (error) {
      logger.error('Failed to create task:', error);
      throw new Error('Database write error');
    }
  }

  async getTask(taskId: number): Promise<ClubTask | null> {
    try {
      const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
        TaskRow | undefined;
      return row ? this.rowToTask(row) : null;
    } catch (error) {
      logger.error('Failed to get task:', error);
      return null;
    }
  }

  async getAllTasks(): Promise<ClubTask[]> {
    const rows = this.db
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC, id DESC')
      .all() as TaskRow[];
    return rows.map((row) => this.rowToTask(row));
  }

  async getUnrevealedTasks(): Promise<ClubTask[]> {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE revealed = 0 ORDER BY created_at DESC, id DESC')
      .all() as TaskRow[];
    return rows.map((row) => this.rowToTask(row));
  }

  async getRevealedTasks(): Promise<ClubTask[]> {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE revealed = 1 ORDER BY created_at DESC, id DESC')
      .all() as TaskRow[];
    return rows.map((row) => this.rowToTask(row));
  }

  async upsertTaskSubmission(input: {
    taskId: number;
    userId: string;
    username: string;
    content: string;
  }): Promise<TaskSubmission> {
    try {
      const upsertSubmission = this.db.transaction(() => {
        const existing = this.db
          .prepare('SELECT * FROM task_submissions WHERE task_id = ? AND user_id = ?')
          .get(input.taskId, input.userId) as TaskSubmissionRow | undefined;

        if (existing) {
          this.db
            .prepare(
              `INSERT INTO task_submission_history (submission_id, task_id, user_id, username, content)
               VALUES (?, ?, ?, ?, ?)`
            )
            .run(
              existing.id,
              existing.task_id,
              existing.user_id,
              existing.username,
              existing.content
            );

          this.db
            .prepare(
              `UPDATE task_submissions
               SET username = ?, content = ?, updated_at = strftime('%s', 'now')
               WHERE id = ?`
            )
            .run(input.username, input.content, existing.id);

          return this.db.prepare('SELECT * FROM task_submissions WHERE id = ?').get(existing.id) as
            TaskSubmissionRow | undefined;
        }

        const result = this.db
          .prepare(
            `INSERT INTO task_submissions (task_id, user_id, username, content)
             VALUES (?, ?, ?, ?)`
          )
          .run(input.taskId, input.userId, input.username, input.content);

        return this.db
          .prepare('SELECT * FROM task_submissions WHERE id = ?')
          .get(result.lastInsertRowid) as TaskSubmissionRow | undefined;
      });

      const row = upsertSubmission();
      if (!row) throw new Error('Inserted submission not found');
      return this.rowToTaskSubmission(row);
    } catch (error) {
      logger.error('Failed to upsert task submission:', error);
      throw new Error('Database write error');
    }
  }

  async getTaskSubmissions(taskId: number): Promise<TaskSubmission[]> {
    const rows = this.db
      .prepare('SELECT * FROM task_submissions WHERE task_id = ? ORDER BY updated_at DESC, id DESC')
      .all(taskId) as TaskSubmissionRow[];
    return rows.map((row) => this.rowToTaskSubmission(row));
  }

  async getTaskSubmissionHistory(submissionId: number): Promise<TaskSubmissionHistory[]> {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM task_submission_history
         WHERE submission_id = ?
         ORDER BY created_at DESC, id DESC`
      )
      .all(submissionId) as TaskSubmissionHistoryRow[];
    return rows.map((row) => this.rowToTaskSubmissionHistory(row));
  }

  async revealTask(taskId: number): Promise<ClubTask | null> {
    try {
      this.db
        .prepare("UPDATE tasks SET revealed = 1, updated_at = strftime('%s', 'now') WHERE id = ?")
        .run(taskId);
      return this.getTask(taskId);
    } catch (error) {
      logger.error('Failed to reveal task:', error);
      throw new Error('Database write error');
    }
  }

  async getTasksWithSubmissions(): Promise<TaskWithSubmissions[]> {
    const tasks = await this.getAllTasks();
    const tasksWithSubmissions: TaskWithSubmissions[] = [];
    for (const task of tasks) {
      tasksWithSubmissions.push({ ...task, submissions: await this.getTaskSubmissions(task.id) });
    }
    return tasksWithSubmissions;
  }

  private rowToTask(row: TaskRow): ClubTask {
    return {
      id: row.id,
      name: row.name,
      category: row.category,
      requirement: row.requirement,
      threadId: row.thread_id,
      channelId: row.channel_id,
      roleId: row.role_id,
      createdBy: row.created_by,
      revealed: row.revealed === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToTaskSubmission(row: TaskSubmissionRow): TaskSubmission {
    return {
      id: row.id,
      taskId: row.task_id,
      userId: row.user_id,
      username: row.username,
      content: row.content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToTaskSubmissionHistory(row: TaskSubmissionHistoryRow): TaskSubmissionHistory {
    return {
      id: row.id,
      submissionId: row.submission_id,
      taskId: row.task_id,
      userId: row.user_id,
      username: row.username,
      content: row.content,
      createdAt: row.created_at,
    };
  }

  /**
   * Convert database row to CTFData
   */
  private rowToCTFData(row: CTFRow): CTFData {
    return {
      ctftimeid: row.ctftimeid,
      role: row.role,
      cate: row.cate,
      name: row.name,
      infom: row.infom,
      channel: row.channel,
      endtime: row.endtime,
      archived: row.archived === 1,
      channelsPurged: row.channels_purged === 1,
      postEndOpened: row.post_end_opened === 1,
      starttime: row.starttime ?? 0,
      competitionEndtime: row.competition_endtime ?? 0,
    };
  }

  private rowToChallenge(row: ChallengeRow): CTFChallenge {
    const migratedClaimants = row.claimed_by ? [row.claimed_by] : [];
    const claimantIds = row.claimant_ids ? parseStringArray(row.claimant_ids) : migratedClaimants;
    const primaryCategory = isChallengeCategory(row.category) ? row.category : 'misc';
    const categories = normalizeChallengeCategories(
      primaryCategory,
      parseStringArray(row.categories)
    );

    return {
      id: row.id,
      ctfId: row.ctf_id,
      threadId: row.thread_id,
      channelId: row.channel_id,
      name: row.name,
      category: primaryCategory,
      categories,
      points: row.points,
      status: row.status as ChallengeStatus,
      claimantIds,
      claimedBy: row.claimed_by ?? undefined,
      claimedAt: row.claimed_at ?? undefined,
      solverIds: parseStringArray(row.solver_ids),
      solvedBy: row.solved_by ?? undefined,
      solvedAt: row.solved_at ?? undefined,
      writeupOwner: row.writeup_owner ?? undefined,
      writeupUrl: row.writeup_url ?? undefined,
      externalSource: row.external_source ?? undefined,
      externalId: row.external_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToChallengeSyncSource(row: ChallengeSyncSourceRow): ChallengeSyncSource {
    return {
      ctfId: row.ctf_id,
      url: row.url,
      provider: row.provider,
      enabled: row.enabled === 1,
      authUsername: row.auth_username ?? undefined,
      authPassword: row.auth_password ?? undefined,
      authCookie: row.auth_cookie ?? undefined,
      lastSyncAt: row.last_sync_at ?? undefined,
      lastError: row.last_error ?? undefined,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToChallengeParserRule(row: ChallengeParserRuleRow): ChallengeParserRule {
    let fields: ChallengeParserRuleFields = { name: 'name' };
    try {
      const parsed: unknown = JSON.parse(row.field_mapping);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const name = typeof record.name === 'string' && record.name.trim() ? record.name : 'name';
        fields = {
          id: typeof record.id === 'string' ? record.id : undefined,
          name,
          category: typeof record.category === 'string' ? record.category : undefined,
          points: typeof record.points === 'string' ? record.points : undefined,
          description: typeof record.description === 'string' ? record.description : undefined,
          connectionInfo:
            typeof record.connectionInfo === 'string' ? record.connectionInfo : undefined,
          files: typeof record.files === 'string' ? record.files : undefined,
          fileName: typeof record.fileName === 'string' ? record.fileName : undefined,
          fileUrl: typeof record.fileUrl === 'string' ? record.fileUrl : undefined,
          url: typeof record.url === 'string' ? record.url : undefined,
        };
      }
    } catch {
      fields = { name: 'name' };
    }

    return {
      id: row.id,
      domain: row.domain,
      sourceUrl: row.source_url,
      endpoint: row.endpoint,
      method: row.method,
      arrayPath: row.array_path,
      fields,
      createdBy: row.created_by,
      failureCount: row.failure_count,
      lastError: row.last_error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToChallengeCategory(row: ChallengeCategoryRow): CTFChallengeCategory {
    return {
      ctfId: row.ctf_id,
      name: isChallengeCategory(row.name) ? row.name : 'misc',
      channelId: row.channel_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

export default new DatabaseService();
