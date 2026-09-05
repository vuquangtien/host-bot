import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function run(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bksec-ctf-command-schema-'));
  process.env.DB_PATH = path.join(directory, 'test.db');
  process.env.SERVER_ID = '100000000000000001';
  process.env.BOT_TOKEN = 'test-token';
  process.env.VIEW_ALL_CTF_ROLEID = '100000000000000002';
  process.env.ACTIVE_CTF_ROLEID = '100000000000000003';
  process.env.ADMIN_ROLE_ID = '100000000000000004';

  const databaseService = (await import('../services/database.service')).default;

  try {
    const ctfCommand = (await import('../commands/general/ctf')).default.data.toJSON();
    assert.equal(ctfCommand.name, 'ctf');
    assert.deepEqual(
      ctfCommand.options?.map((option) => option.name),
      ['create', 'clear-category'],
      '/ctf should expose create plus the admin cleanup helper'
    );

    const create = ctfCommand.options?.find((option) => option.name === 'create');
    const createOptions = 'options' in (create ?? {}) ? (create?.options ?? []) : [];
    const challengeUrl = createOptions.find((option) => option.name === 'challenge_url');
    assert.ok(challengeUrl, '/ctf create should expose challenge_url');
    assert.equal(challengeUrl.required, true, 'challenge_url should be the only required input');

    const requiredOptions = createOptions
      .filter((option) => option.required)
      .map((option) => option.name);
    assert.deepEqual(requiredOptions, ['challenge_url']);
    assert.equal(
      createOptions.some((option) => option.name === 'provider'),
      false,
      '/ctf create should not expose parser/provider choices'
    );
    assert.ok(
      createOptions.some((option) => option.name === 'username'),
      '/ctf create should allow optional login username'
    );
    assert.ok(
      createOptions.some((option) => option.name === 'password'),
      '/ctf create should allow optional login password'
    );
    assert.ok(
      createOptions.some((option) => option.name === 'cookie'),
      '/ctf create should allow optional session cookie'
    );
    assert.ok(
      createOptions.some((option) => option.name === 'token'),
      '/ctf create should allow optional API bearer token'
    );

    const clearCategory = ctfCommand.options?.find((option) => option.name === 'clear-category');
    const clearOptions = 'options' in (clearCategory ?? {}) ? (clearCategory?.options ?? []) : [];
    assert.deepEqual(
      clearOptions.map((option) => option.name),
      ['category', 'confirm'],
      '/ctf clear-category should require a category and exact confirmation'
    );
    assert.deepEqual(
      clearOptions.filter((option) => option.required).map((option) => option.name),
      ['category', 'confirm']
    );

    const ctfId = await databaseService.addCTF({
      ctftimeid: 0,
      role: '100000000000000006',
      cate: '100000000000000007',
      name: 'Auth Test CTF',
      infom: '100000000000000008',
      channel: '100000000000000009',
      endtime: Math.floor(Date.now() / 1000) + 86_400,
      starttime: Math.floor(Date.now() / 1000) - 60,
      competitionEndtime: Math.floor(Date.now() / 1000) + 3_600,
    });
    const source = await databaseService.upsertChallengeSyncSource({
      ctfId,
      url: 'https://ctf.example/challenges',
      provider: 'auto',
      authUsername: 'team-user',
      authPassword: 'team-password',
      authCookie: 'session=abc; csrftoken=def',
      authToken: 'Bearer test-api-token',
      createdBy: '100000000000000005',
    });
    assert.equal(source.authUsername, 'team-user');
    assert.equal(source.authPassword, 'team-password');
    assert.equal(source.authCookie, 'session=abc; csrftoken=def');
    assert.equal(source.authToken, 'Bearer test-api-token');
    const updatedSource = await databaseService.upsertChallengeSyncSource({
      ctfId,
      url: 'https://ctf.example/new-challenges',
      provider: 'auto',
      createdBy: '100000000000000005',
    });
    assert.equal(updatedSource.authUsername, 'team-user');
    assert.equal(updatedSource.authPassword, 'team-password');
    assert.equal(updatedSource.authCookie, 'session=abc; csrftoken=def');
    assert.equal(updatedSource.authToken, 'Bearer test-api-token');

    console.log('ctf command schema tests passed');
  } finally {
    databaseService.close();
    fs.rmSync(directory, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
