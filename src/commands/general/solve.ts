import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import databaseService from '../../services/database.service';
import challengeService from '../../services/challenge.service';
import { errorEmbed, successEmbed, warningEmbed } from '../../utils/embed.builder';
import logger from '../../utils/logger';
import { formatChallengeCategories } from '../../utils/challenge-category';
import { BestEffortTask, runBestEffortTasks } from '../../utils/best-effort';

const SOLVE_FOLLOW_UP_TIMEOUT_MS = 10_000;

async function finishSolveFollowUps(
  interaction: ChatInputCommandInteraction,
  challengeName: string,
  tasks: readonly BestEffortTask[]
): Promise<void> {
  const results = await runBestEffortTasks(tasks, SOLVE_FOLLOW_UP_TIMEOUT_MS);
  const failures = results.filter((result) => result.error !== undefined);

  for (const result of results) {
    if (result.error === undefined) {
      logger.debug(`Solve follow-up "${result.name}" completed in ${result.durationMs}ms`);
      continue;
    }
    logger.warn(
      `Solve follow-up "${result.name}" ${result.timedOut ? 'timed out' : 'failed'} after ${result.durationMs}ms:`,
      result.error
    );
  }

  if (failures.length === 0) return;
  await interaction
    .editReply({
      embeds: [
        warningEmbed(
          'Solve đã được lưu',
          `Không hoàn tất được: ${failures.map((result) => result.name).join(', ')}.`
        ),
      ],
    })
    .catch((error) => logger.warn(`Could not report solve follow-up failures:`, error));
  logger.warn(`Solve follow-ups incomplete for ${challengeName}`);
}

function repairSolvedTasks(
  interaction: ChatInputCommandInteraction,
  ctfKey: string,
  ctfData: Parameters<typeof challengeService.refreshDashboard>[2],
  challenge: Awaited<ReturnType<typeof databaseService.getChallengeByThread>>
): BestEffortTask[] {
  if (!interaction.guild || !challenge) return [];

  const guild = interaction.guild;
  return [
    {
      name: 'đổi tên thread',
      run: () => challengeService.renameThread(guild, challenge),
    },
    {
      name: 'cập nhật dashboard',
      run: () => challengeService.refreshDashboard(guild, ctfKey, ctfData),
    },
  ];
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('solved')
    .setDescription('Đánh dấu challenge hiện tại là solved') as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    let persistedChallengeName: string | null = null;
    try {
      if (!interaction.guild || !interaction.channel?.isThread()) {
        await interaction.reply({
          embeds: [errorEmbed('Hãy chạy `/solved` trong challenge thread.')],
          ephemeral: true,
        });
        return;
      }
      await interaction.deferReply({ ephemeral: true });

      const challenge = await databaseService.getChallengeByThread(interaction.channel.id);
      if (!challenge) {
        await interaction.editReply({
          embeds: [errorEmbed('Thread này chưa được đăng ký là challenge.')],
        });
        return;
      }

      const ctf = await databaseService.findByKey(String(challenge.ctfId));
      if (!ctf) throw new Error('CTF not found');

      if (challenge.status === 'solved') {
        await interaction.editReply({
          embeds: [
            warningEmbed(
              'Challenge đã solved rồi',
              'Mình sẽ cập nhật lại tên thread và dashboard nếu Discord bị hụt ở lần trước.'
            ),
          ],
        });

        const tasks = repairSolvedTasks(interaction, ctf.key, ctf.data, challenge);
        void finishSolveFollowUps(interaction, challenge.name, tasks).catch((error) => {
          logger.error(`Unexpected solve repair failure for ${challenge.name}:`, error);
        });
        return;
      }

      const solveTime = Math.floor(Date.now() / 1000);

      const updated = await databaseService.solveChallenge({
        challengeId: challenge.id,
        recordedBy: interaction.user.id,
        solvedAt: solveTime,
      });
      persistedChallengeName = challenge.name;

      await interaction.editReply({
        embeds: [successEmbed(`Đã solve **${challenge.name}**.`)],
      });

      const guild = interaction.guild;
      const thread = interaction.channel;
      const tasks: BestEffortTask[] = [
        ...repairSolvedTasks(interaction, ctf.key, ctf.data, updated),
        {
          name: 'gửi thông báo',
          run: () =>
            challengeService.announceSolved(
              guild,
              ctf.data,
              `[SOLVED] Chúc mừng! Challenge **${challenge.name}** đã được giải.\n` +
                `Category: **${formatChallengeCategories(challenge.categories)}**\n` +
                `Xác nhận bởi: <@${updated.solvedBy ?? interaction.user.id}>\n` +
                `Thread: <#${challenge.threadId}>`
            ),
        },
        {
          name: 'nhắc write-up',
          run: () =>
            thread.send({
              content:
                `[WRITEUP] Khi có bài, gửi thẳng link HTTP(S) vào thread này.\n` +
                'Bot sẽ tự đăng sang #writeups rồi lock thread.',
              allowedMentions: { parse: [] },
            }),
        },
      ];

      void finishSolveFollowUps(interaction, challenge.name, tasks).catch((error) => {
        logger.error(`Unexpected solve follow-up failure for ${challenge.name}:`, error);
      });
    } catch (error) {
      logger.error(
        persistedChallengeName ? 'Solve was saved but response failed:' : 'Solve failed:',
        error
      );
      const payload = {
        embeds: [
          persistedChallengeName
            ? warningEmbed(
                'Solve đã được lưu',
                `Discord không hoàn tất phản hồi cho **${persistedChallengeName}**.`
              )
            : errorEmbed('Không thể cập nhật solve.'),
        ],
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => undefined);
      } else {
        await interaction.reply({ ...payload, ephemeral: true }).catch(() => undefined);
      }
    }
  },
};

export default command;
