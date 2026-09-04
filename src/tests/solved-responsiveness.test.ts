import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const solveSource = fs.readFileSync(
  path.join(process.cwd(), 'src/commands/general/solve.ts'),
  'utf8'
);
const persistedAt = solveSource.indexOf('databaseService.solveChallenge');
const acknowledgedAt = solveSource.indexOf('Đã solve **${challenge.name}**.');
const backgroundAt = solveSource.indexOf('void finishSolveFollowUps', acknowledgedAt);
const repairAcknowledgedAt = solveSource.indexOf('Challenge đã solved rồi');
const repairBackgroundAt = solveSource.indexOf('void finishSolveFollowUps', repairAcknowledgedAt);

assert.ok(persistedAt >= 0, '/solved must persist the solve');
assert.ok(acknowledgedAt > persistedAt, '/solved must acknowledge only after persistence succeeds');
assert.ok(
  backgroundAt > acknowledgedAt,
  '/solved must acknowledge before starting non-critical Discord follow-ups'
);
assert.ok(
  repairBackgroundAt > repairAcknowledgedAt,
  '/solved repair mode must acknowledge before retrying Discord follow-ups'
);
assert.match(solveSource, /runBestEffortTasks\(tasks, SOLVE_FOLLOW_UP_TIMEOUT_MS\)/);

const challengeServiceSource = fs.readFileSync(
  path.join(process.cwd(), 'src/services/challenge.service.ts'),
  'utf8'
);
assert.equal(
  challengeServiceSource.match(/reconcileCategoryChildrenPermissions\s*\(/g)?.length,
  1,
  'system-channel permission reconciliation must only occur when a missing channel is created'
);

console.log('solved responsiveness tests passed');
