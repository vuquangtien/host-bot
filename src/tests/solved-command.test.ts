import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatInputCommandInteraction } from 'discord.js';

async function run(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bksec-solved-command-'));
  process.env.DB_PATH = path.join(directory, 'test.db');
  process.env.SERVER_ID = '100000000000000001';
  process.env.BOT_TOKEN = 'test-token';
  process.env.VIEW_ALL_CTF_ROLEID = '100000000000000002';
  process.env.ACTIVE_CTF_ROLEID = '100000000000000003';
  process.env.ADMIN_ROLE_ID = '100000000000000004';

  const databaseService = (await import('../services/database.service')).default;
  const challengeService = (await import('../services/challenge.service')).default;
  const solveCommand = (await import('../commands/general/solve')).default;
  const originalMethods = {
    renameThread: challengeService.renameThread,
    announceSolved: challengeService.announceSolved,
    refreshDashboard: challengeService.refreshDashboard,
  };

  const pendingResolvers: Array<() => void> = [];
  const pending = () =>
    new Promise<void>((resolve) => {
      pendingResolvers.push(resolve);
    });

  try {
    const ctfId = await databaseService.addCTF({
      ctftimeid: 1,
      role: 'ctf-role',
      cate: 'ctf-category',
      name: 'Responsive CTF',
      infom: 'info-message',
      channel: 'info-channel',
      endtime: 3_000,
      starttime: 1_000,
      competitionEndtime: 2_000,
    });
    await databaseService.createChallenge({
      ctfId,
      threadId: 'challenge-thread',
      channelId: 'web-channel',
      name: 'Never Block',
      category: 'web',
      points: 100,
    });
    const alreadySolved = await databaseService.createChallenge({
      ctfId,
      threadId: 'already-solved-thread',
      channelId: 'web-channel',
      name: 'Repair Me',
      category: 'web',
      points: 200,
    });
    await databaseService.solveChallenge({
      challengeId: alreadySolved.id,
      recordedBy: 'previous-solver',
      solvedAt: 1_500,
    });

    challengeService.renameThread = async () => pending();
    challengeService.announceSolved = async () => pending();
    challengeService.refreshDashboard = async () => pending();

    const replies: unknown[] = [];
    let deferred = false;
    const interaction = {
      guild: {},
      channel: {
        id: 'challenge-thread',
        isThread: () => true,
        send: () => pending(),
      },
      member: {
        roles: { cache: { has: () => false } },
        permissions: { has: () => false },
      },
      user: { id: 'solver-user' },
      get deferred() {
        return deferred;
      },
      replied: false,
      deferReply: async () => {
        deferred = true;
      },
      editReply: async (payload: unknown) => {
        replies.push(payload);
      },
      reply: async (payload: unknown) => {
        replies.push(payload);
      },
    } as unknown as ChatInputCommandInteraction;

    await Promise.race([
      solveCommand.execute(interaction),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('/solved waited for follow-up tasks')), 500)
      ),
    ]);

    assert.equal(replies.length, 1, '/solved should acknowledge immediately after persistence');
    assert.equal(
      (await databaseService.getChallengeByThread('challenge-thread'))?.status,
      'solved'
    );
    assert.equal(pendingResolvers.length, 4, 'all follow-up tasks should start in the background');

    for (const resolve of pendingResolvers) resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    let repairedRenames = 0;
    let repairedDashboards = 0;
    let duplicateAnnouncements = 0;
    challengeService.renameThread = async () => {
      repairedRenames++;
    };
    challengeService.announceSolved = async () => {
      duplicateAnnouncements++;
    };
    challengeService.refreshDashboard = async () => {
      repairedDashboards++;
    };

    const repairReplies: unknown[] = [];
    let repairDeferred = false;
    const repairInteraction = {
      guild: {},
      channel: {
        id: 'already-solved-thread',
        isThread: () => true,
        send: async () => undefined,
      },
      member: {
        roles: { cache: { has: () => false } },
        permissions: { has: () => false },
      },
      user: { id: 'solver-user' },
      get deferred() {
        return repairDeferred;
      },
      replied: false,
      deferReply: async () => {
        repairDeferred = true;
      },
      editReply: async (payload: unknown) => {
        repairReplies.push(payload);
      },
      reply: async (payload: unknown) => {
        repairReplies.push(payload);
      },
    } as unknown as ChatInputCommandInteraction;

    await solveCommand.execute(repairInteraction);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(repairReplies.length, 1, 'already solved repair should acknowledge once');
    assert.equal(repairedRenames, 1, 'already solved repair should retry thread rename');
    assert.equal(repairedDashboards, 1, 'already solved repair should retry dashboard refresh');
    assert.equal(
      duplicateAnnouncements,
      0,
      'already solved repair should not send a duplicate solved announcement'
    );
  } finally {
    challengeService.renameThread = originalMethods.renameThread;
    challengeService.announceSolved = originalMethods.announceSolved;
    challengeService.refreshDashboard = originalMethods.refreshDashboard;
    databaseService.close();
    fs.rmSync(directory, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
}

run()
  .then(() => console.log('solved command tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
