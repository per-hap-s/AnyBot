import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface InstalledSkill {
  name: string;
  description: string;
  filePath: string;
}

type SkillDirEntry = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
};

function getCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(os.homedir(), ".codex");
}

function getSkillsRoot(): string {
  return path.join(getCodexHome(), "skills");
}

function walkForSkillFiles(dirPath: string, acc: string[]): void {
  let entries: SkillDirEntry[];
  try {
    entries = readdirSync(dirPath, {
      withFileTypes: true,
      encoding: "utf8",
    }) as unknown as SkillDirEntry[];
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkForSkillFiles(fullPath, acc);
      continue;
    }

    if (entry.isFile() && entry.name === "SKILL.md") {
      acc.push(fullPath);
    }
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith(`"`) && trimmed.endsWith(`"`)) ||
    (trimmed.startsWith(`'`) && trimmed.endsWith(`'`))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontMatter(raw: string): Record<string, string> {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) {
    return {};
  }

  const lines = normalized.split(/\r?\n/);
  const frontMatter: Record<string, string> = {};
  let closed = false;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() || "";
    if (line === "---") {
      closed = true;
      break;
    }
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key) {
      frontMatter[key] = unquote(value);
    }
  }

  return closed ? frontMatter : {};
}

function fallbackSkillName(filePath: string): string {
  return path.basename(path.dirname(filePath));
}

function parseSkill(filePath: string): InstalledSkill | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const frontMatter = parseFrontMatter(raw);
  const name = frontMatter.name?.trim() || fallbackSkillName(filePath);
  const description = frontMatter.description?.trim() || "No description available.";

  return {
    name,
    description,
    filePath,
  };
}

export function listInstalledSkills(): InstalledSkill[] {
  const skillsRoot = getSkillsRoot();
  if (!existsSync(skillsRoot)) {
    return [];
  }

  const skillFiles: string[] = [];
  walkForSkillFiles(skillsRoot, skillFiles);

  return skillFiles
    .map((filePath) => parseSkill(filePath))
    .filter((skill): skill is InstalledSkill => Boolean(skill))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function formatInstalledSkillsForPrompt(): string {
  const skills = listInstalledSkills();
  const lines = [
    "Installed Codex skills:",
  ];

  if (skills.length === 0) {
    lines.push("- None detected in CODEX_HOME/skills.");
  } else {
    for (const skill of skills) {
      lines.push(`- ${skill.name}: ${skill.description}`);
    }
  }

  lines.push(
    "- If the user asks which skills are available or installed, answer from this list directly.",
    "- Do not claim an unlisted skill is installed.",
  );

  return lines.join("\n");
}
