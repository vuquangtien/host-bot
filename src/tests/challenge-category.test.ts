import assert from 'node:assert/strict';
import {
  isDefaultChallengeCategory,
  normalizeChallengeCategories,
  normalizeChallengeCategoryName,
  RESERVED_CHALLENGE_CHANNELS,
} from '../utils/challenge-category';

assert.equal(normalizeChallengeCategoryName(' AI / ML '), 'ai-ml');
assert.equal(normalizeChallengeCategoryName('Phần Cứng'), 'phan-cung');
assert.equal(normalizeChallengeCategoryName('Reverse'), 'rev');
assert.equal(normalizeChallengeCategoryName('Forensic'), 'forensics');
assert.equal(normalizeChallengeCategoryName('---'), null);
assert.equal(isDefaultChallengeCategory('web'), true);
assert.equal(isDefaultChallengeCategory('hardware'), false);
assert.deepEqual(normalizeChallengeCategories('hardware', ['web', 'hardware', 'AI / ML']), [
  'hardware',
  'web',
  'ai-ml',
]);
assert.equal(RESERVED_CHALLENGE_CHANNELS.includes('solved'), true);
assert.equal(RESERVED_CHALLENGE_CHANNELS.includes('writeups'), true);

console.log('challenge category tests passed');
