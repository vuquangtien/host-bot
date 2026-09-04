import dotenv from 'dotenv';
import { EnvConfig } from '../types';
import logger from '../utils/logger';

// Load environment variables
dotenv.config();

/**
 * Validate and export environment configuration
 */
function validateEnv(): EnvConfig {
  const requiredVars = [
    'SERVER_ID',
    'BOT_TOKEN',
    'VIEW_ALL_CTF_ROLEID',
    'ACTIVE_CTF_ROLEID',
    'ADMIN_ROLE_ID',
    // TODO: RE-ENABLE — task commands temporarily disabled. Uncomment these
    // when the task env vars are set in .env, and also restore the imports/
    // registrations/handlers in src/index.ts.
    // 'TASK_ADMIN_CHANNEL_ID',
    // 'TASK_ROLE_PWN',
    // 'TASK_ROLE_REV',
    // 'TASK_ROLE_CRYPTO',
    // 'TASK_ROLE_ALL',
  ];
  const missing: string[] = [];

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  }

  if (missing.length > 0) {
    logger.error(`Missing required environment variables: ${missing.join(', ')}`);
    logger.error('Please create a .env file based on .env.example');
    process.exit(1);
  }

  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      // The missing-variable branch above exits before this can occur.
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
  };

  const serverId = required('SERVER_ID');
  const botToken = required('BOT_TOKEN');
  const viewAllRoleId = required('VIEW_ALL_CTF_ROLEID');
  const activeRoleId = required('ACTIVE_CTF_ROLEID');
  const adminRoleId = required('ADMIN_ROLE_ID');
  const publicCTFChannels = ['1', 'true', 'yes', 'on'].includes(
    (process.env.PUBLIC_CTF_CHANNELS ?? '').trim().toLocaleLowerCase()
  );
  const discordIds = {
    SERVER_ID: serverId,
    VIEW_ALL_CTF_ROLEID: viewAllRoleId,
    ACTIVE_CTF_ROLEID: activeRoleId,
    ADMIN_ROLE_ID: adminRoleId,
  };
  const invalidIds = Object.entries(discordIds)
    .filter(([, value]) => !/^\d{17,20}$/.test(value))
    .map(([name]) => name);
  if (invalidIds.length > 0) {
    logger.error(`Invalid Discord IDs: ${invalidIds.join(', ')}`);
    process.exit(1);
  }

  let denyRoleId = process.env.DENY_CTF_ROLEID;
  if (activeRoleId === viewAllRoleId) {
    logger.warn(
      'ACTIVE_CTF_ROLEID and VIEW_ALL_CTF_ROLEID use the same role; phase-specific visibility is disabled'
    );
  }
  if (denyRoleId && [activeRoleId, viewAllRoleId].includes(denyRoleId)) {
    logger.warn('DENY_CTF_ROLEID conflicts with an allowed CTF role and has been disabled');
    denyRoleId = undefined;
  }

  return {
    SERVER_ID: serverId,
    BOT_TOKEN: botToken,
    VIEW_ALL_CTF_ROLEID: viewAllRoleId,
    ACTIVE_CTF_ROLEID: activeRoleId,
    VERIFIED_ROLE_ID: process.env.VERIFIED_ROLE_ID ?? '',
    ADMIN_ROLE_ID: adminRoleId,
    TASK_ADMIN_CHANNEL_ID: process.env.TASK_ADMIN_CHANNEL_ID ?? '',
    TASK_ROLE_PWN: process.env.TASK_ROLE_PWN ?? '',
    TASK_ROLE_REV: process.env.TASK_ROLE_REV ?? '',
    TASK_ROLE_CRYPTO: process.env.TASK_ROLE_CRYPTO ?? '',
    TASK_ROLE_ALL: process.env.TASK_ROLE_ALL ?? '',
    LOG_CHANNELID: process.env.LOG_CHANNELID,
    DENY_CTF_ROLEID: denyRoleId,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '',
    GH_INVITE_REPO_OWNER: process.env.GH_INVITE_REPO_OWNER ?? '',
    GH_INVITE_REPO_NAME: process.env.GH_INVITE_REPO_NAME ?? '',
    VERIFY_REMOVE_ROLE_ID: process.env.VERIFY_REMOVE_ROLE_ID,
    VERIFY_GRANT_ROLE_ID: process.env.VERIFY_GRANT_ROLE_ID,
    VERIFY_ALLOWED_ROLE_ID: process.env.VERIFY_ALLOWED_ROLE_ID,
    PUBLIC_CTF_CHANNELS: publicCTFChannels,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '',
    GEMINI_MODEL: process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest',
  };
}

export const config = validateEnv();
