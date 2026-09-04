import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { Command } from '../../types';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Hướng dẫn sử dụng các lệnh CTF cơ bản'),

  async execute(interaction: ChatInputCommandInteraction) {
    const embed = new EmbedBuilder()
      .setTitle('BKSEC CTF Bot - Hướng dẫn nhanh')
      .setColor(0xd50000)
      .setDescription(
        'Flow mới: admin tạo giải một lần, bot tự sync chall, người chơi chỉ cần chat và solve.'
      )
      .addFields(
        {
          name: 'Admin',
          value:
            '`/ctf create challenge_url:<url>` - Tạo giải từ URL và bật auto-sync.\n' +
            '`name`, `ctftime_id`, `start_at`, `end_at` chỉ cần khi muốn đặt rõ.',
        },
        {
          name: 'Người chơi',
          value:
            'Bot tự tạo thread khi sync thấy chall mới.\n' +
            'Nhắn vào thread challenge để tự nhận làm.\n' +
            '`/solved` - Đánh dấu challenge hiện tại đã giải.',
        },
        {
          name: 'Write-up',
          value:
            'Sau khi `/solved`, gửi link writeup HTTP(S) vào thread. Bot tự đăng sang `writeups` và khóa thread.',
        }
      )
      .setFooter({ text: 'Dùng lệnh trong đúng channel hoặc challenge thread tương ứng.' });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

export default command;
