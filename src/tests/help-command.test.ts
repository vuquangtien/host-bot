import assert from 'node:assert/strict';
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  InteractionReplyOptions,
  MessageFlags,
} from 'discord.js';
import helpCommand from '../commands/general/help';

async function run(): Promise<void> {
  const responses: InteractionReplyOptions[] = [];
  const interaction = {
    reply: async (response: InteractionReplyOptions) => {
      responses.push(response);
    },
  } as unknown as ChatInputCommandInteraction;

  await helpCommand.execute(interaction);

  const schema = helpCommand.data.toJSON();
  assert.equal(schema.name, 'help');
  assert.deepEqual(schema.options ?? [], []);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].flags, MessageFlags.Ephemeral);

  const embed = responses[0].embeds?.[0];
  assert.ok(embed instanceof EmbedBuilder);
  const data = embed.toJSON();
  assert.match(data.title ?? '', /Hướng dẫn nhanh/);
  const helpText = data.fields?.map((field) => field.value).join('\n') ?? '';
  assert.match(helpText, /\/ctf create/);
  assert.match(helpText, /\/solved/);
  assert.match(helpText, /writeup HTTP\(S\)/);
  assert.doesNotMatch(helpText, /\/ctf sync/);
  assert.doesNotMatch(helpText, /\/ctf challenge/);
  assert.doesNotMatch(helpText, /\/writeup/);

  console.log('help command tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
