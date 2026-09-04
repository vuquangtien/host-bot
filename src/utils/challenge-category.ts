import { CHALLENGE_CATEGORIES, ChallengeCategory } from '../types';

const DEFAULT_CATEGORY_SET = new Set<string>(CHALLENGE_CATEGORIES);
const CATEGORY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CATEGORY_LENGTH = 32;
const CATEGORY_ALIASES: Record<string, ChallengeCategory> = {
  forensic: 'forensics',
  forensiccs: 'forensics',
  reverse: 'rev',
  reversing: 'rev',
};

export const RESERVED_CHALLENGE_CHANNELS = [
  'announcements',
  'solved',
  'writeups',
  'general',
] as const;

export function normalizeChallengeCategoryName(value: string): ChallengeCategory | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[đĐ]/g, 'd')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, MAX_CATEGORY_LENGTH)
    .replace(/-+$/g, '');

  if (CATEGORY_ALIASES[normalized]) return CATEGORY_ALIASES[normalized];
  return isChallengeCategory(normalized) ? normalized : null;
}

export function isChallengeCategory(value: string): value is ChallengeCategory {
  return value.length > 0 && value.length <= MAX_CATEGORY_LENGTH && CATEGORY_PATTERN.test(value);
}

export function isDefaultChallengeCategory(value: string): boolean {
  return DEFAULT_CATEGORY_SET.has(value);
}

export function normalizeChallengeCategories(
  primary: ChallengeCategory,
  additional: readonly string[] = []
): ChallengeCategory[] {
  const categories: ChallengeCategory[] = [primary];

  for (const category of additional) {
    const normalized = normalizeChallengeCategoryName(category);
    if (normalized && !categories.includes(normalized)) {
      categories.push(normalized);
    }
  }

  return categories;
}

export function formatChallengeCategories(categories: readonly ChallengeCategory[]): string {
  return categories.map((category) => category.toUpperCase()).join(' / ');
}
