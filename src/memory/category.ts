import type { MemoryCategory } from "./types.js";

export const MEMORY_CATEGORY_ORDER: MemoryCategory[] = [
  "identity",
  "preference",
  "workflow",
  "environment",
  "project",
];

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: "Preference",
  identity: "Identity",
  workflow: "Workflow",
  environment: "Environment",
  project: "Project",
};

const CATEGORY_PATTERNS: Record<MemoryCategory, RegExp[]> = {
  identity: [
    /\u6211\u53eb/,
    /\u53eb\u6211/,
    /\u88ab\u79f0\u4e3a/,
    /\u79f0\u547c/,
    /\u540d\u5b57/,
    /\u8eab\u4efd/,
    /\u6211\u662f\u8c01/,
    /\bcall me\b/i,
    /\bmy name\b/i,
    /\bidentity\b/i,
    /\bprofile\b/i,
  ],
  preference: [
    /\u7528\u6237\u504f\u597d/,
    /\u504f\u597d/,
    /\u98ce\u683c/,
    /\u8bed\u6c14/,
    /\u7b80\u77ed/,
    /\u5c11\u8bf4\u5e9f\u8bdd/,
    /\u5148\u7ed9\u7ed3\u8bba/,
    /\u5c3d\u91cf/,
    /\u4e0d\u8981/,
    /\u5c11\u7528/,
    /\bprefer\b/i,
    /\bdefault\b/i,
    /\bavoid\b/i,
    /\btone\b/i,
  ],
  workflow: [
    /\u5de5\u4f5c\u6d41/,
    /\u6d41\u7a0b/,
    /\u5ba1\u67e5/,
    /\u6c47\u62a5/,
    /\u6b65\u9aa4/,
    /\u4efb\u52a1\u6587\u4ef6/,
    /\u624b\u518c/,
    /\u8054\u7f51\u9a8c\u8bc1/,
    /\u9010\u6761\u5ba1\u67e5/,
    /\u5de5\u4f5c\u65b9\u5f0f/,
    /\bworkflow\b/i,
  ],
  environment: [
    /\u73af\u5883/,
    /\u7cfb\u7edf/,
    /\u8bb0\u5fc6\u5b9e\u73b0/,
    /\u7ed3\u6784\u5316\u8bb0\u5fc6/,
    /\brag\b/i,
    /\bembedding\b/i,
    /\bbge\b/i,
    /\bsiliconflow\b/i,
    /\bcodex cli\b/i,
    /\bchat\.db\b/i,
  ],
  project: [
    /\u9879\u76ee/,
    /\u4ed3\u5e93/,
    /\u4efb\u52a1/,
    /\banybot\b/i,
    /\bproxypilot\b/i,
    /\bopenclaw\b/i,
    /\bcodexask\b/i,
    /\brepo\b/i,
    /\brepository\b/i,
  ],
};

export type QueryCategoryAnalysis = {
  primary: MemoryCategory | null;
  secondary: MemoryCategory | null;
  confidence: number;
  scores: Record<MemoryCategory, number>;
};

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === "string" && value in MEMORY_CATEGORY_LABELS;
}

function createEmptyScores(): Record<MemoryCategory, number> {
  return {
    identity: 0,
    preference: 0,
    workflow: 0,
    environment: 0,
    project: 0,
  };
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

export function inferMemoryCategoryFromText(text: string): MemoryCategory {
  const analysis = analyzeQueryCategories(text);
  if (analysis.primary) {
    return analysis.primary;
  }
  return "workflow";
}

export function analyzeQueryCategories(queryText: string): QueryCategoryAnalysis {
  const normalized = normalizeText(queryText);
  const scores = createEmptyScores();

  if (!normalized) {
    return {
      primary: null,
      secondary: null,
      confidence: 0,
      scores,
    };
  }

  for (const category of MEMORY_CATEGORY_ORDER) {
    for (const pattern of CATEGORY_PATTERNS[category]) {
      if (pattern.test(normalized)) {
        scores[category] += 1;
      }
    }
  }

  if (/\u8bb0\u5fc6|\u8bb0\u4f4f|\u5173\u4e8e\u6211|\bmemory\b/i.test(normalized)) {
    scores.identity += 0.4;
    scores.preference += 0.4;
    scores.workflow += 0.2;
    scores.environment += 0.2;
  }

  const ranked = MEMORY_CATEGORY_ORDER
    .map((category) => ({ category, score: scores[category] }))
    .sort((left, right) => right.score - left.score || compareMemoryCategory(left.category, right.category));

  const primary = ranked[0] && ranked[0].score > 0 ? ranked[0].category : null;
  const secondary = ranked[1] && ranked[1].score >= Math.max(1, (ranked[0]?.score ?? 0) * 0.55)
    ? ranked[1].category
    : null;
  const total = ranked.reduce((sum, item) => sum + item.score, 0);
  const confidence = primary && total > 0 ? Math.min(1, (ranked[0].score + (ranked[0].score - (ranked[1]?.score || 0))) / (total + 1)) : 0;

  return {
    primary,
    secondary,
    confidence,
    scores,
  };
}

export function inferRelevantCategories(queryText: string): Set<MemoryCategory> {
  const analysis = analyzeQueryCategories(queryText);
  const categories = new Set<MemoryCategory>();
  if (analysis.primary) {
    categories.add(analysis.primary);
  }
  if (analysis.secondary) {
    categories.add(analysis.secondary);
  }
  for (const category of MEMORY_CATEGORY_ORDER) {
    if (analysis.scores[category] >= 1) {
      categories.add(category);
    }
  }
  return categories;
}

export function compareMemoryCategory(left: MemoryCategory, right: MemoryCategory): number {
  return MEMORY_CATEGORY_ORDER.indexOf(left) - MEMORY_CATEGORY_ORDER.indexOf(right);
}
