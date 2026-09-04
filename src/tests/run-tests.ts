import { spawn } from 'child_process';

const args = process.argv.slice(2);
const runTestsByPathIndex = args.indexOf('--runTestsByPath');
const testFiles =
  runTestsByPathIndex >= 0
    ? args.slice(runTestsByPathIndex + 1).filter((arg) => !arg.startsWith('--'))
    : [
        'src/tests/task-database.test.ts',
        'src/tests/challenge-database.test.ts',
        'src/tests/challenge-category.test.ts',
        'src/tests/challenge-category-migration.test.ts',
        'src/tests/challenge-list-view.test.ts',
        'src/tests/challenge-sync-generic.test.ts',
        'src/tests/ctf-command-schema.test.ts',
        'src/tests/challenge-command-schema.test.ts',
        'src/tests/help-command.test.ts',
        'src/tests/best-effort.test.ts',
        'src/tests/solved-responsiveness.test.ts',
        'src/tests/solved-command.test.ts',
        'src/tests/ctf-visibility.test.ts',
        'src/tests/ctf-channel-permissions.test.ts',
        'src/tests/ctf-schedule.test.ts',
        'src/tests/ctf-datetime.test.ts',
        'src/tests/ctf-credentials.test.ts',
      ];

if (testFiles.length === 0) {
  throw new Error('--runTestsByPath requires at least one test path');
}

async function runTestFile(testFile: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', testFile], {
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test' },
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${testFile} failed with exit code ${code}`));
    });
  });
}

async function run(): Promise<void> {
  for (const testFile of testFiles) {
    await runTestFile(testFile);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
