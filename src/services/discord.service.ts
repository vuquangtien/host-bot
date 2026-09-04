import {
  Guild,
  CategoryChannel,
  TextChannel,
  Role,
  ChannelType,
  GuildScheduledEventCreateOptions,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  OverwriteType,
  PermissionFlagsBits,
  type NonThreadGuildBasedChannel,
  type PermissionOverwriteOptions,
  type RoleResolvable,
  type UserResolvable,
} from 'discord.js';
import logger from '../utils/logger';
import { config } from '../config/env';
import databaseService from './database.service';
import { isCtfLive } from '../utils/ctf-visibility';
import { CTFData } from '../types';
import {
  buildChildVisibilityPlan,
  buildManagedVisibilityPolicy,
} from '../utils/ctf-channel-permissions';

const READ_ONLY_CTF_CHANNELS = new Set(['announcements', 'solved', 'writeups']);

/**
 * Discord helper service for managing channels, roles, and permissions
 */
class DiscordService {
  private usesPublicCTFChannels(): boolean {
    return config.PUBLIC_CTF_CHANNELS;
  }

  private async mayManagePermissions(channelId: string, channelName: string): Promise<boolean> {
    const managed = await databaseService.isManagedDiscordChannel(channelId);
    if (!managed) {
      logger.info(
        `Preserved permissions for manually managed channel: ${channelName} (${channelId})`
      );
    }
    return managed;
  }

  private async editManagedPermissionOverwrite(
    channel: NonThreadGuildBasedChannel,
    target: RoleResolvable | UserResolvable,
    permissions: PermissionOverwriteOptions
  ): Promise<boolean> {
    if (!(await this.mayManagePermissions(channel.id, channel.name))) return false;
    await channel.permissionOverwrites.edit(target, permissions);
    return true;
  }

  private async deleteManagedPermissionOverwrite(
    channel: NonThreadGuildBasedChannel,
    target: RoleResolvable | UserResolvable
  ): Promise<boolean> {
    if (!(await this.mayManagePermissions(channel.id, channel.name))) return false;
    await channel.permissionOverwrites.delete(target);
    return true;
  }

  private async ensureBotCanManageChannel(
    guild: Guild,
    channel: NonThreadGuildBasedChannel
  ): Promise<void> {
    const botMember = guild.members.me ?? (await guild.members.fetchMe());
    await this.editManagedPermissionOverwrite(channel, botMember.id, {
      ViewChannel: true,
      ManageChannels: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
  }

  async reconcileCategoryChildrenPermissions(
    category: CategoryChannel,
    perCtfRoleId?: string
  ): Promise<void> {
    if (this.usesPublicCTFChannels()) return;

    const managedChannelIds = await databaseService.getManagedDiscordChannelIds(category.id);
    const managedRoleIds = [config.ACTIVE_CTF_ROLEID, config.VIEW_ALL_CTF_ROLEID, perCtfRoleId];
    const categoryAllowedRoleIds = managedRoleIds.filter((roleId): roleId is string => {
      if (!roleId) return false;
      return Boolean(
        category.permissionOverwrites.cache.get(roleId)?.allow.has(PermissionFlagsBits.ViewChannel)
      );
    });
    const policy = buildManagedVisibilityPolicy(
      managedRoleIds,
      categoryAllowedRoleIds,
      config.DENY_CTF_ROLEID
    );

    for (const [, channel] of category.children.cache) {
      const isSystemChannel =
        channel.type === ChannelType.GuildText && READ_ONLY_CTF_CHANNELS.has(channel.name);
      const currentAllowedRoleIds = channel.permissionOverwrites.cache
        .filter(
          (overwrite) =>
            overwrite.type === OverwriteType.Role &&
            overwrite.allow.has(PermissionFlagsBits.ViewChannel)
        )
        .map((overwrite) => overwrite.id);
      const plan = buildChildVisibilityPlan({
        managedByBot: managedChannelIds.has(channel.id),
        // `null` means Discord.js cannot prove the parent relationship from
        // cache; preserve it rather than risking a destructive desync.
        permissionsLocked: channel.permissionsLocked !== false,
        isSystemChannel,
        currentAllowedRoleIds,
        policy,
      });

      if (!plan.enforceEveryoneDeny) continue;

      await this.editManagedPermissionOverwrite(channel, category.guild.roles.everyone, {
        ViewChannel: false,
        ...(isSystemChannel ? { SendMessages: false } : {}),
      });
      for (const roleId of plan.allowedRoleIds) {
        await this.editManagedPermissionOverwrite(channel, roleId, {
          ViewChannel: true,
          SendMessages: false,
        });
      }
      for (const roleId of plan.deniedRoleIds) {
        await this.editManagedPermissionOverwrite(channel, roleId, {
          ViewChannel: false,
          ...(isSystemChannel ? { SendMessages: false } : {}),
        });
      }
      if (isSystemChannel && category.guild.members.me) {
        await this.editManagedPermissionOverwrite(channel, category.guild.members.me, {
          ViewChannel: true,
          SendMessages: true,
        });
      }
    }
  }

  async rollbackCTFCreation(guild: Guild, categoryId?: string, roleId?: string): Promise<void> {
    if (categoryId) {
      const categoryDeleted = await this.deleteCTFCategory(guild, categoryId);
      if (!categoryDeleted) {
        logger.error(`Rollback could not delete category ${categoryId}`);
      }
    }

    if (roleId) {
      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (role) {
        await role.delete('Rolling back failed CTF registration').catch((error) => {
          logger.error(`Rollback could not delete role ${roleId}:`, error);
        });
      }
    }
  }

  /**
   * Create CTF category with channels and role
   */
  async createCTFCategory(
    guild: Guild,
    name: string
  ): Promise<{
    category: CategoryChannel;
    role: Role;
    infoChannel: TextChannel;
  } | null> {
    let role: Role | null = null;
    let category: CategoryChannel | null = null;

    try {
      const normalizedName = name.trim().slice(0, 100);
      if (!normalizedName) throw new Error('CTF name cannot be empty');

      // Create role
      role = await guild.roles.create({
        name: normalizedName.toLowerCase(),
        mentionable: false,
        position: 1,
      });

      logger.info(`Created role: ${role.name}`);

      // Create category
      category = await guild.channels.create({
        name: normalizedName,
        type: ChannelType.GuildCategory,
      });
      await databaseService.registerManagedDiscordChannel({
        channelId: category.id,
        kind: 'category',
      });

      // Live-phase visibility: active role only
      await this.applyLivePermissions(guild, category.id, role.id);

      logger.info(`Created category: ${category.name}`);

      // Create info channel. It must carry NO overwrites of its own: any overwrite
      // desyncs it from the category, and it would then stop tracking the category's
      // @everyone deny (leaving it visible server-wide). Synced means it is private
      // to the active role like the challenge channels, and members who can see it
      // can also talk in it.
      const infoChannel = await guild.channels.create({
        name: normalizedName,
        type: ChannelType.GuildText,
        parent: category.id,
      });
      await databaseService.registerManagedDiscordChannel({
        channelId: infoChannel.id,
        parentCategoryId: category.id,
        kind: 'info',
      });

      logger.info(`Created info channel: ${infoChannel.name}`);

      // Create other challenge channels
      const channelNames = [
        'announcements',
        'solved',
        'writeups',
        'general',
        'web',
        'crypto',
        'pwn',
        'rev',
        'forensics',
        'misc',
      ];

      for (const channelName of channelNames) {
        const childChannel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: category.id,
        });
        await databaseService.registerManagedDiscordChannel({
          channelId: childChannel.id,
          parentCategoryId: category.id,
          kind: READ_ONLY_CTF_CHANNELS.has(channelName) ? 'system' : 'challenge',
        });
        logger.debug(`Created channel: ${channelName}`);
      }
      await this.reconcileCategoryChildrenPermissions(category, role.id);

      return { category, role, infoChannel };
    } catch (error) {
      logger.error('Error creating CTF category:', error);
      await this.rollbackCTFCreation(guild, category?.id, role?.id);
      return null;
    }
  }

  /**
   * Create special/manual CTF category (not from CTFtime)
   */
  async createSpecialCTFCategory(
    guild: Guild,
    name: string
  ): Promise<{
    category: CategoryChannel;
    role: Role;
    infoChannel: TextChannel;
    generalChannel: TextChannel;
  } | null> {
    let role: Role | null = null;
    let category: CategoryChannel | null = null;

    try {
      const normalizedName = name.trim().slice(0, 80);
      if (!normalizedName) throw new Error('CTF name cannot be empty');

      // Create role (with angle brackets for special CTFs)
      role = await guild.roles.create({
        name: `<${normalizedName}>`,
        mentionable: true,
        position: 1,
      });

      logger.info(`Created special role: ${role.name}`);

      // Create category
      category = await guild.channels.create({
        name: normalizedName,
        type: ChannelType.GuildCategory,
      });
      await databaseService.registerManagedDiscordChannel({
        channelId: category.id,
        kind: 'category',
      });

      // Live-phase visibility: active role only
      await this.applyLivePermissions(guild, category.id, role.id);

      logger.info(`Created special category: ${category.name}`);

      // Keep CTF information and its progress dashboard in a dedicated channel.
      const infoChannel = await guild.channels.create({
        name: normalizedName,
        type: ChannelType.GuildText,
        parent: category.id,
      });
      await databaseService.registerManagedDiscordChannel({
        channelId: infoChannel.id,
        parentCategoryId: category.id,
        kind: 'info',
      });

      // Create general discussion channel
      const generalChannel = await guild.channels.create({
        name: 'general',
        type: ChannelType.GuildText,
        parent: category.id,
      });
      await databaseService.registerManagedDiscordChannel({
        channelId: generalChannel.id,
        parentCategoryId: category.id,
        kind: 'challenge',
      });

      const announcementsChannel = await guild.channels.create({
        name: 'announcements',
        type: ChannelType.GuildText,
        parent: category.id,
      });
      await databaseService.registerManagedDiscordChannel({
        channelId: announcementsChannel.id,
        parentCategoryId: category.id,
        kind: 'system',
      });

      const solvedChannel = await guild.channels.create({
        name: 'solved',
        type: ChannelType.GuildText,
        parent: category.id,
      });
      await databaseService.registerManagedDiscordChannel({
        channelId: solvedChannel.id,
        parentCategoryId: category.id,
        kind: 'system',
      });

      const writeupsChannel = await guild.channels.create({
        name: 'writeups',
        type: ChannelType.GuildText,
        parent: category.id,
      });
      await databaseService.registerManagedDiscordChannel({
        channelId: writeupsChannel.id,
        parentCategoryId: category.id,
        kind: 'system',
      });

      // Keep manual and CTFtime categories consistent so auto-registration works.
      const channelNames = ['web', 'crypto', 'pwn', 'rev', 'forensics', 'misc'];

      for (const channelName of channelNames) {
        const childChannel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: category.id,
        });
        await databaseService.registerManagedDiscordChannel({
          channelId: childChannel.id,
          parentCategoryId: category.id,
          kind: 'challenge',
        });
      }
      await this.reconcileCategoryChildrenPermissions(category, role.id);

      return { category, role, infoChannel, generalChannel };
    } catch (error) {
      logger.error('Error creating special CTF category:', error);
      await this.rollbackCTFCreation(guild, category?.id, role?.id);
      return null;
    }
  }

  /**
   * Archive CTF category (hide from @everyone)
   */
  async archiveCTFCategory(
    guild: Guild,
    categoryId: string,
    infoChannelId?: string,
    perCtfRoleId?: string
  ): Promise<boolean> {
    try {
      const category = await guild.channels.fetch(categoryId).catch(() => null);

      if (!category) {
        logger.warn(`Category not found: ${categoryId}`);
        return false;
      }
      if (category.type !== ChannelType.GuildCategory) {
        logger.warn(`Channel is not a category: ${categoryId}`);
        return false;
      }
      if (this.usesPublicCTFChannels()) {
        logger.info(`Archived category without permission changes: ${category.name}`);
        return true;
      }
      if (!(await this.mayManagePermissions(category.id, category.name))) return true;

      await this.editManagedPermissionOverwrite(category, guild.roles.everyone, {
        ViewChannel: false,
      });
      if (config.DENY_CTF_ROLEID) {
        await this.editManagedPermissionOverwrite(category, config.DENY_CTF_ROLEID, {
          ViewChannel: false,
        });
      }
      await this.reconcileCategoryChildrenPermissions(category, perCtfRoleId);

      if (infoChannelId) logger.debug(`Archived info channel ${infoChannelId} with its category`);

      logger.info(`Archived category: ${category.name}`);
      return true;
    } catch (error) {
      logger.error('Error archiving category:', error);
      return false;
    }
  }

  async archiveRegisteredCTF(guild: Guild, ctf: CTFData): Promise<boolean> {
    const credentialsRedacted = await this.redactCTFCredentials(guild, ctf.channel, ctf.infom);
    if (!credentialsRedacted) return false;
    return this.archiveCTFCategory(guild, ctf.cate, ctf.channel, ctf.role);
  }

  async archiveCTFRecord(guild: Guild, key: string, ctf: CTFData): Promise<boolean> {
    if (!(await this.archiveRegisteredCTF(guild, ctf))) return false;
    try {
      await databaseService.updateCTF(key, { archived: true });
      return true;
    } catch (error) {
      logger.error(`Discord archived ${ctf.name}, but the DB update failed:`, error);
      return false;
    }
  }

  /**
   * Delete CTF category and all channels
   */
  async deleteCTFCategory(guild: Guild, categoryId: string): Promise<boolean> {
    try {
      const category = await guild.channels.fetch(categoryId).catch(() => null);

      if (!category) {
        await databaseService.removeManagedDiscordCategory(categoryId);
        logger.info(`Category already absent: ${categoryId}`);
        return true;
      }
      if (category.type !== ChannelType.GuildCategory) {
        logger.warn(`Channel is not a category: ${categoryId}`);
        return false;
      }

      // Delete all channels in category
      for (const [, channel] of category.children.cache) {
        await channel.delete();
        logger.debug(`Deleted channel: ${channel.name}`);
      }

      // Delete category
      await category.delete();
      await databaseService.removeManagedDiscordCategory(categoryId);
      logger.info(`Deleted category: ${category.name}`);

      return true;
    } catch (error) {
      logger.error('Error deleting category:', error);
      return false;
    }
  }

  /**
   * Unlink a CTF category while keeping it private to CTF archive roles.
   */
  async unlistCTFCategory(guild: Guild, categoryId: string): Promise<boolean> {
    try {
      const channel = await guild.channels.fetch(categoryId).catch(() => null);

      if (!channel || channel.type !== ChannelType.GuildCategory) {
        logger.warn(`Category not found: ${categoryId}`);
        return false;
      }
      const category = channel;

      if (!category.name.startsWith('[UNLISTED]')) {
        await category.setName(`[UNLISTED] ${category.name}`.slice(0, 100));
      }
      if (this.usesPublicCTFChannels()) {
        logger.info(`Unlisted category without permission changes: ${category.name}`);
        return true;
      }
      if (!(await this.mayManagePermissions(category.id, category.name))) return true;

      await this.editManagedPermissionOverwrite(category, guild.roles.everyone, {
        ViewChannel: false,
      });
      await this.editManagedPermissionOverwrite(category, config.ACTIVE_CTF_ROLEID, {
        ViewChannel: true,
      });
      await this.editManagedPermissionOverwrite(category, config.VIEW_ALL_CTF_ROLEID, {
        ViewChannel: true,
      });
      if (config.DENY_CTF_ROLEID) {
        await this.editManagedPermissionOverwrite(category, config.DENY_CTF_ROLEID, {
          ViewChannel: false,
        });
      }
      await this.reconcileCategoryChildrenPermissions(category);

      logger.info(`Unlisted category: ${category.name}`);
      return true;
    } catch (error) {
      logger.error('Error unlisting category:', error);
      return false;
    }
  }

  /**
   * Re-list an unlisted category
   */
  async relistCTFCategory(
    guild: Guild,
    categoryId: string,
    _roleName: string
  ): Promise<Role | null> {
    let role: Role | null = null;
    let originalName: string | undefined;
    try {
      const channel = await guild.channels.fetch(categoryId).catch(() => null);
      if (channel?.type !== ChannelType.GuildCategory) {
        logger.warn(`Category not found: ${categoryId}`);
        return null;
      }
      const category = channel;
      originalName = category.name;

      // Remove [UNLISTED] prefix if present
      let newName = category.name;
      if (newName.startsWith('[UNLISTED]')) {
        newName = newName.replace('[UNLISTED]', '').trim();
        await category.setName(newName);
      }
      if (this.usesPublicCTFChannels()) {
        logger.info(`Re-listed category without permission changes: ${category.name}`);
        return null;
      }

      // Create role
      role = await guild.roles.create({
        name: `<${newName}>`,
        position: 1,
      });

      // Get the VIEW_ALL_CTF role
      const viewAllRole = guild.roles.cache.get(config.VIEW_ALL_CTF_ROLEID);

      if (await this.mayManagePermissions(category.id, category.name)) {
        // Set permissions only when the category was originally created by the bot.
        await this.editManagedPermissionOverwrite(category, role, {
          ViewChannel: true,
        });

        if (viewAllRole) {
          await this.editManagedPermissionOverwrite(category, viewAllRole, {
            ViewChannel: true,
          });
        }

        await this.editManagedPermissionOverwrite(category, guild.roles.everyone, {
          ViewChannel: false,
        });

        await this.reconcileCategoryChildrenPermissions(category, role.id);
      }

      logger.info(`Re-listed category: ${category.name}`);
      return role;
    } catch (error) {
      logger.error('Error re-listing category:', error);
      if (role) await role.delete('Rolling back failed CTF relist').catch(() => undefined);
      if (originalName) {
        const category = await guild.channels.fetch(categoryId).catch(() => null);
        if (category?.type === ChannelType.GuildCategory && category.name !== originalName) {
          await category.setName(originalName).catch(() => undefined);
        }
      }
      return null;
    }
  }

  /**
   * Live-phase category visibility: active role only (plus DENY deny).
   * Removes any per-CTF / VIEW_ALL grants so only active-role members can see it.
   */
  async applyLivePermissions(
    guild: Guild,
    categoryId: string,
    perCtfRoleId: string
  ): Promise<void> {
    const channel = await guild.channels.fetch(categoryId).catch(() => null);
    if (channel?.type !== ChannelType.GuildCategory) {
      throw new Error(`applyLivePermissions: category not found: ${categoryId}`);
    }
    const category = channel;
    if (this.usesPublicCTFChannels()) return;
    if (!(await this.mayManagePermissions(category.id, category.name))) return;

    await this.ensureBotCanManageChannel(guild, category);

    // @everyone HAS ViewChannel in this guild's base permissions, so it must be
    // denied explicitly — role allows alone would hide nothing.
    await this.editManagedPermissionOverwrite(category, guild.roles.everyone, {
      ViewChannel: false,
    });

    await this.editManagedPermissionOverwrite(category, config.ACTIVE_CTF_ROLEID, {
      ViewChannel: true,
    });

    if (config.DENY_CTF_ROLEID) {
      await this.editManagedPermissionOverwrite(category, config.DENY_CTF_ROLEID, {
        ViewChannel: false,
      });
    }

    // Ensure the per-CTF role and VIEW_ALL role cannot see it while live.
    for (const roleId of [perCtfRoleId, config.VIEW_ALL_CTF_ROLEID]) {
      if (
        roleId &&
        roleId !== config.ACTIVE_CTF_ROLEID &&
        category.permissionOverwrites.cache.has(roleId)
      ) {
        await this.deleteManagedPermissionOverwrite(category, roleId);
      }
    }

    await this.reconcileCategoryChildrenPermissions(category, perCtfRoleId);
  }

  /**
   * Ended-phase category visibility: additionally grant per-CTF role + VIEW_ALL.
   * The active-role grant is intentionally left in place. @everyone stays denied,
   * so access remains role-gated (matching how archived categories behave).
   */
  async applyEndedPermissions(
    guild: Guild,
    categoryId: string,
    perCtfRoleId: string
  ): Promise<void> {
    const channel = await guild.channels.fetch(categoryId).catch(() => null);
    if (channel?.type !== ChannelType.GuildCategory) {
      throw new Error(`applyEndedPermissions: category not found: ${categoryId}`);
    }
    const category = channel;
    if (this.usesPublicCTFChannels()) return;
    if (!(await this.mayManagePermissions(category.id, category.name))) return;

    await this.editManagedPermissionOverwrite(category, guild.roles.everyone, {
      ViewChannel: false,
    });

    if (perCtfRoleId) {
      await this.editManagedPermissionOverwrite(category, perCtfRoleId, {
        ViewChannel: true,
      });
    }
    await this.editManagedPermissionOverwrite(category, config.VIEW_ALL_CTF_ROLEID, {
      ViewChannel: true,
    });
    if (config.DENY_CTF_ROLEID) {
      await this.editManagedPermissionOverwrite(category, config.DENY_CTF_ROLEID, {
        ViewChannel: false,
      });
    }
    await this.reconcileCategoryChildrenPermissions(category, perCtfRoleId);
  }

  /** Remove shared credentials before a CTF becomes visible to archive roles. */
  async redactCTFCredentials(
    guild: Guild,
    infoChannelId: string,
    infoMessageId: string
  ): Promise<boolean> {
    if (!infoChannelId || infoChannelId === '0' || !infoMessageId || infoMessageId === '0') {
      return true;
    }

    try {
      const channel = await guild.channels.fetch(infoChannelId).catch(() => null);
      if (channel?.type !== ChannelType.GuildText) return true;

      const message = await channel.messages.fetch(infoMessageId).catch(() => null);
      if (!message) return true;

      let changed = false;
      const embeds = message.embeds.map((messageEmbed) => {
        const embed = messageEmbed.toJSON();
        if (!embed.fields) return embed;

        embed.fields = embed.fields.map((field) => {
          if (field.name.toLowerCase() !== 'login') return field;
          changed = true;
          return {
            ...field,
            value: 'Credentials removed automatically after the competition ended.',
          };
        });
        return embed;
      });

      if (changed) await message.edit({ embeds });
      return true;
    } catch (error) {
      logger.error(`Failed to redact credentials in channel ${infoChannelId}:`, error);
      return false;
    }
  }

  /**
   * Revert any CTF whose time has run out to ended-phase visibility.
   * Idempotent via the post_end_opened flag. Returns the number reverted.
   * Best-effort: a failure on one CTF is logged and skipped (retried next
   * sweep) rather than aborting the batch or throwing to the caller.
   */
  async syncEndedCTFs(guild: Guild): Promise<number> {
    const all = await databaseService.getAllCTFs();
    const now = Math.floor(Date.now() / 1000);
    let reverted = 0;

    for (const { key, data } of all) {
      if (data.archived || data.channelsPurged) continue;
      if (!data.cate || data.cate === '0') continue;
      if (data.postEndOpened) continue;
      const competitionEnd = data.competitionEndtime || data.endtime;
      if (isCtfLive(competitionEnd, now)) continue;

      try {
        const credentialsRedacted = await this.redactCTFCredentials(
          guild,
          data.channel,
          data.infom
        );
        if (!credentialsRedacted) {
          logger.warn(`Keeping ${data.name} private because credential redaction failed`);
          continue;
        }
        await this.applyEndedPermissions(guild, data.cate, data.role);
        await databaseService.updateCTF(key, { postEndOpened: true });
        reverted++;
        logger.info(`Reverted ended CTF to normal visibility: ${data.name}`);
      } catch (error) {
        logger.error(`Error reverting ended CTF to normal visibility: ${data.name}`, error);
        continue;
      }
    }

    return reverted;
  }

  /**
   * Create Discord scheduled event for CTF
   */
  async createCTFEvent(
    guild: Guild,
    name: string,
    startTime: Date,
    endTime: Date
  ): Promise<boolean> {
    try {
      const eventOptions: GuildScheduledEventCreateOptions = {
        name: name.slice(0, 100),
        description: `CTF Event: ${name}`,
        scheduledStartTime: startTime,
        scheduledEndTime: endTime,
        entityType: GuildScheduledEventEntityType.External,
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityMetadata: {
          location: 'SoICT, B1-403',
        },
      };

      await guild.scheduledEvents.create(eventOptions);
      logger.info(`Created scheduled event: ${name}`);
      return true;
    } catch (error) {
      logger.error('Error creating scheduled event:', error);
      return false;
    }
  }
}

export default new DiscordService();
