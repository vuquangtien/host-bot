import { ChannelType, ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { CTFInfo, ChallengeSyncProvider, Command } from '../../types';
import ctftimeService from '../../services/ctftime.service';
import databaseService from '../../services/database.service';
import discordService from '../../services/discord.service';
import challengeService from '../../services/challenge.service';
import challengeSyncService from '../../services/challenge-sync.service';
import { createEmbed, errorEmbed, successEmbed, warningEmbed } from '../../utils/embed.builder';
import { isAdmin } from '../../utils/role.guard';
import logger from '../../utils/logger';
import {
  buildManualCTFSchedule,
  DEFAULT_MANUAL_ARCHIVE_DAYS,
  manualScheduleErrorMessage,
  parseCTFDateTime,
} from '../../utils/ctf-datetime';

const DEFAULT_URL_ONLY_DURATION_DAYS = 7;

interface ArchiveSummary {
  archived: number;
  failed: number;
}

function normalizeSourceUrl(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.toString();
  } catch {
    return null;
  }
}

function readableNamePart(value: string): string {
  return value
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

function inferCTFName(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  const pathPart = url.pathname
    .split('/')
    .filter(Boolean)
    .find(
      (part) =>
        !/^(api|v\d+|challenge|challenges|chall|challs|task|tasks|problem|problems)$/i.test(part)
    );
  const hostParts = url.hostname
    .replace(/^www\./i, '')
    .split('.')
    .filter((part) => !/^(ctf|team|com|org|net|io|app|dev)$/i.test(part));
  const base = readableNamePart(pathPart ?? hostParts[0] ?? url.hostname);
  return /\bctf\b/i.test(base) ? base.slice(0, 80) : `${base} CTF`.slice(0, 80);
}

async function archiveExpiredCTFs(
  interaction: ChatInputCommandInteraction
): Promise<ArchiveSummary> {
  if (!interaction.guild) return { archived: 0, failed: 0 };

  const expiredCTFs = await databaseService.getExpiredCTFs(Math.floor(Date.now() / 1000));
  let archived = 0;
  let failed = 0;

  for (const ctf of expiredCTFs) {
    if (!(await discordService.archiveCTFRecord(interaction.guild, ctf.key, ctf.data))) {
      failed++;
      continue;
    }
    archived++;
  }

  return { archived, failed };
}

async function syncNow(
  interaction: ChatInputCommandInteraction,
  ctfKey: string,
  sourceUrl: string | null,
  provider: ChallengeSyncProvider,
  authUsername?: string,
  authPassword?: string
): Promise<string> {
  if (!interaction.guild) return '';

  const ctf = await databaseService.findByKey(ctfKey);
  if (!ctf) throw new Error('CTF not found after creation');

  let source = await databaseService.getChallengeSyncSource(Number(ctf.key));
  if (sourceUrl) {
    source = await databaseService.upsertChallengeSyncSource({
      ctfId: Number(ctf.key),
      url: sourceUrl,
      provider,
      authUsername,
      authPassword,
      createdBy: interaction.user.id,
    });
  }
  if (!source?.enabled) return '';

  try {
    const summary = await challengeSyncService.syncCTF(
      interaction.guild,
      ctf.key,
      ctf.data,
      source
    );
    await databaseService.markChallengeSyncResult(Number(ctf.key), {
      ok: true,
      syncedAt: Math.floor(Date.now() / 1000),
    });
    return (
      `\nAuto-sync: tạo ${summary.created}, nhận diện sẵn ${summary.adopted}, ` +
      `tổng ${summary.fetched} chall (${summary.provider}).`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await databaseService.markChallengeSyncResult(Number(ctf.key), { ok: false, error: message });
    logger.warn(`Initial challenge sync failed for ${ctf.data.name}:`, error);
    return `\nAuto-sync chưa chạy được: ${message.slice(0, 220)}`;
  }
}

async function createFromCTFtime(
  interaction: ChatInputCommandInteraction,
  ctftimeId: number,
  sourceUrl: string | null,
  provider: ChallengeSyncProvider,
  authUsername?: string,
  authPassword?: string
): Promise<void> {
  if (!interaction.guild) return;

  const existing = await databaseService.findByCTFTimeId(ctftimeId);
  if (existing) {
    await interaction.editReply({
      embeds: [
        warningEmbed('CTF đã tồn tại', `Giải này đã có channel: <#${existing.data.channel}>.`),
      ],
    });
    return;
  }

  const result = await ctftimeService.getCTF(ctftimeId, true);
  if (!result || !('archiveAt' in result)) {
    await interaction.editReply({ embeds: [errorEmbed('Không lấy được thông tin CTFtime.')] });
    return;
  }
  const ctfInfo = result as CTFInfo;
  const created = await discordService.createCTFCategory(interaction.guild, ctfInfo.title);
  if (!created) {
    await interaction.editReply({ embeds: [errorEmbed('Không tạo được channel giải.')] });
    return;
  }

  const { category, role, infoChannel } = created;
  let databaseId: number | undefined;

  try {
    const infoMessage = await infoChannel.send({ embeds: [createEmbed(ctfInfo.embedData)] });
    await infoMessage
      .pin()
      .catch((error) => logger.warn(`Could not pin info message for ${ctfInfo.title}:`, error));
    databaseId = await databaseService.addCTF({
      ctftimeid: ctftimeId,
      role: role.id,
      cate: category.id,
      name: ctfInfo.title,
      infom: infoMessage.id,
      channel: infoChannel.id,
      endtime: ctfInfo.archiveAt,
      starttime: ctfInfo.startTime,
      competitionEndtime: ctfInfo.endTime,
    });
  } catch (error) {
    await discordService.rollbackCTFCreation(interaction.guild, category.id, role.id);
    throw error;
  }

  const registeredCTF = await databaseService.findByKey(String(databaseId));
  if (registeredCTF) {
    await challengeService
      .refreshDashboard(interaction.guild, registeredCTF.key, registeredCTF.data)
      .catch((error) => logger.warn(`Initial dashboard failed for ${ctfInfo.title}:`, error));
  }
  await discordService
    .createCTFEvent(
      interaction.guild,
      ctfInfo.title,
      new Date(ctfInfo.startTime * 1000),
      new Date(ctfInfo.endTime * 1000)
    )
    .catch((error) => logger.warn(`Could not create scheduled event for ${ctfInfo.title}:`, error));

  const syncMessage = await syncNow(
    interaction,
    String(databaseId),
    sourceUrl,
    provider,
    authUsername,
    authPassword
  );
  const archiveSummary = await archiveExpiredCTFs(interaction);
  await interaction.editReply({
    embeds: [
      successEmbed(
        `Đã tạo khu vực **${ctfInfo.title}** tại <#${infoChannel.id}>.${syncMessage}` +
          (archiveSummary.failed ? `\nArchive tự động lỗi ${archiveSummary.failed} giải cũ.` : '')
      ),
    ],
  });
}

async function createManual(
  interaction: ChatInputCommandInteraction,
  sourceUrl: string | null,
  provider: ChallengeSyncProvider,
  authUsername?: string,
  authPassword?: string
): Promise<void> {
  if (!interaction.guild) return;

  if (!sourceUrl) {
    await interaction.editReply({
      embeds: [errorEmbed('Nhập `challenge_url` là đủ để tạo giải.')],
    });
    return;
  }

  const name = interaction.options.getString('name')?.trim() || inferCTFName(sourceUrl);
  const startInput = interaction.options.getString('start_at');
  const endInput = interaction.options.getString('end_at');
  const days = interaction.options.getInteger('hide_after') ?? DEFAULT_MANUAL_ARCHIVE_DAYS;
  const now = Math.floor(Date.now() / 1000);
  const defaultStartTime = now - 60;
  let schedule = {
    startTime: defaultStartTime,
    endTime: defaultStartTime + DEFAULT_URL_ONLY_DURATION_DAYS * 86_400,
    archiveAt: defaultStartTime + (DEFAULT_URL_ONLY_DURATION_DAYS + days) * 86_400,
    archiveAfterDays: days,
  };

  if (startInput && endInput) {
    const scheduleResult = buildManualCTFSchedule(startInput, endInput, days);
    if (!scheduleResult.ok) {
      await interaction.editReply({
        embeds: [errorEmbed(manualScheduleErrorMessage(scheduleResult.error))],
      });
      return;
    }
    schedule = scheduleResult.schedule;
  } else if (startInput || endInput) {
    const startTime = startInput ? parseCTFDateTime(startInput) : defaultStartTime;
    const endTime = endInput
      ? parseCTFDateTime(endInput)
      : startTime
        ? startTime + DEFAULT_URL_ONLY_DURATION_DAYS * 86_400
        : null;
    if (startTime === null || endTime === null) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            startInput
              ? manualScheduleErrorMessage('invalid_start')
              : manualScheduleErrorMessage('invalid_end')
          ),
        ],
      });
      return;
    }
    if (endTime <= startTime) {
      await interaction.editReply({
        embeds: [errorEmbed(manualScheduleErrorMessage('end_not_after_start'))],
      });
      return;
    }
    schedule = {
      startTime,
      endTime,
      archiveAt: endTime + days * 86_400,
      archiveAfterDays: days,
    };
  }

  if (schedule.endTime <= Math.floor(Date.now() / 1000)) {
    await interaction.editReply({
      embeds: [errorEmbed('Giờ kết thúc phải nằm trong tương lai.')],
    });
    return;
  }

  const duplicate = (await databaseService.getAllCTFs()).some(
    (ctf) => ctf.data.name.toLocaleLowerCase() === name.toLocaleLowerCase()
  );
  if (duplicate) {
    await interaction.editReply({
      embeds: [warningEmbed('CTF đã tồn tại', 'Đã có một CTF cùng tên trong database.')],
    });
    return;
  }

  const created = await discordService.createSpecialCTFCategory(interaction.guild, name);
  if (!created) {
    await interaction.editReply({ embeds: [errorEmbed('Không tạo được channel giải.')] });
    return;
  }

  const { category, role, infoChannel, generalChannel } = created;
  let databaseId: number | undefined;

  try {
    databaseId = await databaseService.addCTF({
      ctftimeid: 0,
      role: role.id,
      cate: category.id,
      name,
      infom: '0',
      channel: infoChannel.id,
      endtime: schedule.archiveAt,
      starttime: schedule.startTime,
      competitionEndtime: schedule.endTime,
    });
  } catch (error) {
    await discordService.rollbackCTFCreation(interaction.guild, category.id, role.id);
    throw error;
  }

  const registeredCTF = await databaseService.findByKey(String(databaseId));
  if (registeredCTF) {
    await challengeService
      .refreshDashboard(interaction.guild, registeredCTF.key, registeredCTF.data)
      .catch((error) => logger.warn(`Initial dashboard failed for ${name}:`, error));
  }
  if (schedule.startTime > Math.floor(Date.now() / 1000)) {
    await discordService
      .createCTFEvent(
        interaction.guild,
        name,
        new Date(schedule.startTime * 1000),
        new Date(schedule.endTime * 1000)
      )
      .catch((error) => logger.warn(`Could not create scheduled event for ${name}:`, error));
  }

  const syncMessage = await syncNow(
    interaction,
    String(databaseId),
    sourceUrl,
    provider,
    authUsername,
    authPassword
  );
  const archiveSummary = await archiveExpiredCTFs(interaction);
  await interaction.editReply({
    embeds: [
      successEmbed(
        `Đã tạo khu vực **${name}**.\n` +
          `Info: <#${infoChannel.id}> · Chat: <#${generalChannel.id}>.\n` +
          `Bắt đầu <t:${schedule.startTime}:F>, kết thúc <t:${schedule.endTime}:F>.${syncMessage}` +
          (archiveSummary.failed ? `\nArchive tự động lỗi ${archiveSummary.failed} giải cũ.` : '')
      ),
    ],
  });
}

async function clearCategoryChannels(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;

  const category = interaction.options.getChannel('category', true);
  if (category.type !== ChannelType.GuildCategory) {
    await interaction.editReply({ embeds: [errorEmbed('Hãy chọn một category Discord.')] });
    return;
  }

  const confirm = interaction.options.getString('confirm', true).trim();
  if (confirm !== category.name) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `Để tránh xóa nhầm, nhập đúng tên category vào \`confirm\`: \`${category.name}\`.`
        ),
      ],
    });
    return;
  }

  await interaction.guild.channels.fetch();
  const children = interaction.guild.channels.cache.filter(
    (channel) =>
      'parentId' in channel && channel.parentId === category.id && channel.id !== category.id
  );

  if (children.size === 0) {
    await interaction.editReply({
      embeds: [successEmbed(`Category **${category.name}** đang không có channel con.`)],
    });
    return;
  }

  let deleted = 0;
  const failed: string[] = [];
  for (const channel of children.values()) {
    const channelName = channel.name;
    try {
      await channel.delete(`Clear category requested by ${interaction.user.tag}`);
      await databaseService.removeManagedDiscordChannel(channel.id);
      deleted++;
    } catch (error) {
      failed.push(channelName);
      logger.warn(`Could not delete channel ${channel.id} in category ${category.name}:`, error);
    }
  }

  const message =
    `Đã xóa ${deleted}/${children.size} channel trong category **${category.name}**.` +
    (failed.length > 0 ? `\nKhông xóa được: ${failed.slice(0, 8).join(', ')}` : '');
  await interaction.editReply({
    embeds: [failed.length > 0 ? warningEmbed('Xóa chưa hết', message) : successEmbed(message)],
  });
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('ctf')
    .setDescription('Tạo giải và đồng bộ challenge')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('create')
        .setDescription('Admin: tạo khu vực CTF, có thể bật tự sync challenge')
        .addStringOption((option) =>
          option
            .setName('challenge_url')
            .setDescription('URL trang challenge')
            .setRequired(true)
            .setMaxLength(500)
        )
        .addIntegerOption((option) =>
          option.setName('ctftime_id').setDescription('ID trên CTFtime nếu có').setMinValue(1)
        )
        .addStringOption((option) =>
          option.setName('name').setDescription('Tên giải nếu không dùng CTFtime').setMaxLength(80)
        )
        .addStringOption((option) =>
          option
            .setName('start_at')
            .setDescription('Bắt đầu: YYYY-MM-DD HH:mm UTC+7, ISO hoặc Unix')
            .setMaxLength(64)
        )
        .addStringOption((option) =>
          option
            .setName('end_at')
            .setDescription('Kết thúc: YYYY-MM-DD HH:mm UTC+7, ISO hoặc Unix')
            .setMaxLength(64)
        )
        .addIntegerOption((option) =>
          option
            .setName('hide_after')
            .setDescription('Số ngày sau khi kết thúc trước khi archive')
            .setMinValue(0)
            .setMaxValue(365)
        )
        .addStringOption((option) =>
          option
            .setName('username')
            .setDescription('Tài khoản CTF nếu trang challenge cần đăng nhập')
            .setMaxLength(200)
        )
        .addStringOption((option) =>
          option
            .setName('password')
            .setDescription('Mật khẩu/token CTF nếu trang challenge cần đăng nhập')
            .setMaxLength(500)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('clear-category')
        .setDescription('Admin: xóa toàn bộ channel con trong một category')
        .addChannelOption((option) =>
          option
            .setName('category')
            .setDescription('Category cần dọn')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName('confirm')
            .setDescription('Nhập đúng tên category để xác nhận')
            .setRequired(true)
            .setMaxLength(100)
        )
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    try {
      await interaction.deferReply();
      if (!interaction.guild) {
        await interaction.editReply({
          embeds: [errorEmbed('Lệnh này chỉ dùng được trong server.')],
        });
        return;
      }
      if (!(await isAdmin(interaction))) {
        await interaction.editReply({
          embeds: [errorEmbed('Bạn không có quyền tạo CTF.')],
        });
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'clear-category') {
        await clearCategoryChannels(interaction);
        return;
      }

      const rawUrl = interaction.options.getString('challenge_url', true);
      const sourceUrl = normalizeSourceUrl(rawUrl);
      if (!sourceUrl) {
        await interaction.editReply({ embeds: [errorEmbed('URL sync không hợp lệ.')] });
        return;
      }

      const provider: ChallengeSyncProvider = 'auto';
      const authUsername = interaction.options.getString('username')?.trim();
      const authPassword = interaction.options.getString('password') ?? undefined;
      if ((authUsername && !authPassword) || (!authUsername && authPassword)) {
        await interaction.editReply({
          embeds: [errorEmbed('Nếu trang cần đăng nhập, hãy nhập đủ cả `username` và `password`.')],
        });
        return;
      }
      const ctftimeId = interaction.options.getInteger('ctftime_id');
      if (ctftimeId) {
        await createFromCTFtime(
          interaction,
          ctftimeId,
          sourceUrl,
          provider,
          authUsername,
          authPassword
        );
        return;
      }

      await createManual(interaction, sourceUrl, provider, authUsername, authPassword);
    } catch (error) {
      logger.error('CTF command failed:', error);
      const payload = { embeds: [errorEmbed('Không hoàn tất được thao tác CTF.')] };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => undefined);
      } else {
        await interaction.reply({ ...payload, ephemeral: true }).catch(() => undefined);
      }
    }
  },
};

export default command;
