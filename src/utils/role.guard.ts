import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  GuildMember,
  PermissionFlagsBits,
} from 'discord.js';
import { config } from '../config/env';
import { errorEmbed } from './embed.builder';

async function replyPermissionError(
  interaction: ChatInputCommandInteraction,
  message: string
): Promise<void> {
  const payload = { embeds: [errorEmbed(message)] };
  if (interaction.deferred) {
    await interaction.editReply(payload);
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({ ...payload, ephemeral: true });
    return;
  }
  await interaction.reply({ ...payload, ephemeral: true });
}

export async function requireRole(
  interaction: ChatInputCommandInteraction,
  roleId: string
): Promise<boolean> {
  if (!interaction.guild || !interaction.member) {
    await replyPermissionError(interaction, 'This command must be used in a server');
    return false;
  }

  const member = interaction.member as GuildMember;
  const hasRole = member.roles.cache.has(roleId);
  const isAdministrator = member.permissions.has(PermissionFlagsBits.Administrator);

  if (!hasRole && !isAdministrator) {
    await replyPermissionError(interaction, 'You do not have permission to use this command');
    return false;
  }

  return true;
}

export async function isAdmin(
  interaction: ChatInputCommandInteraction | ButtonInteraction
): Promise<boolean> {
  if (!interaction.guild || !config.ADMIN_ROLE_ID) return false;

  const member = await interaction.guild.members.fetch(interaction.user.id);
  return (
    member.roles.cache.has(config.ADMIN_ROLE_ID) ||
    member.permissions.has(PermissionFlagsBits.Administrator)
  );
}

export async function requireAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (await isAdmin(interaction)) return true;

  await replyPermissionError(interaction, 'You do not have permission to use this command');
  return false;
}
