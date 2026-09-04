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
