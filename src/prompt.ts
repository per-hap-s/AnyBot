import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSkillsPromptSection } from "./skills.js";

const CORE_PROMPT_FILE_ORDER = [
  "AGENTS.md",
  "SOUL.md",
  "PROFILE.md",
] as const;

// 文件名 → 语义化标题，AI 更容易理解每段职责
const SECTION_TITLES: Record<string, string> = {
  "AGENTS.md": "行为规则",
  "SOUL.md": "身份与风格",
  "PROFILE.md": "用户偏好",
  "MEMORY.md": "项目记忆",
};

const OPTIONAL_PROMPT_FILE_ORDER = ["MEMORY.md"] as const;

const RUNTIME_PROMPT_FILE_ORDER = [
  ...CORE_PROMPT_FILE_ORDER,
  ...OPTIONAL_PROMPT_FILE_ORDER,
] as const;

const TEMPLATE_FILE_ORDER = [
  ...RUNTIME_PROMPT_FILE_ORDER,
  "BOOTSTRAP.md",
] as const;

const DEFAULT_PROMPT_DIR = fileURLToPath(
  new URL("./agents/md_files/zh", import.meta.url),
);

function stripFrontmatter(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) {
    return trimmed;
  }

  const parts = trimmed.split("---");
  if (parts.length < 3) {
    return trimmed;
  }

  return parts.slice(2).join("---").trim();
}

function resolvePromptDir(promptDir?: string): string {
  if (!promptDir?.trim()) {
    return DEFAULT_PROMPT_DIR;
  }

  return path.resolve(promptDir);
}

function readMarkdownFile(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }

  const rawContent = readFileSync(filePath, "utf8");
  const content = stripFrontmatter(rawContent);
  return content || null;
}

function ensureWorkspacePromptFiles(
  workdir: string,
  templateDir: string,
): void {
  mkdirSync(workdir, { recursive: true });

  for (const filename of TEMPLATE_FILE_ORDER) {
    const sourcePath = path.join(templateDir, filename);
    const targetPath = path.join(workdir, filename);

    if (!existsSync(sourcePath) || existsSync(targetPath)) {
      continue;
    }

    copyFileSync(sourcePath, targetPath);
  }
}

function shouldIncludeMemory(conversationText?: string): boolean {
  const normalized = conversationText?.trim();
  if (!normalized) {
    return false;
  }

  if (
    normalized.length <= 12 &&
    /^(你好|您好|在吗|hi|hello|hey|ok|okay|收到|好的|嗯|哈喽)$/i.test(
      normalized,
    )
  ) {
    return false;
  }

  return /(```|`[^`]+`|\/|\\|\.([cm]?[jt]sx?|py|md|json|yaml|yml|env)\b|npm\b|node\b|git\b|bash\b|shell\b|代码|仓库|项目|文件|目录|路径|环境变量|命令|日志|报错|错误|测试|调试|实现|重构|优化|提示词|上下文|记忆|飞书|机器人|Codex|prompt|memory|profile|agent|sandbox|记住|忘掉|忘记|删掉|人设|风格|偏好|规则|叫我|你叫)/i.test(
    normalized,
  );
}

function loadPromptSections(
  workdir: string,
  conversationText?: string,
): string[] {
  const sections: string[] = [];

  for (const filename of CORE_PROMPT_FILE_ORDER) {
    const filePath = path.join(workdir, filename);
    const content = readMarkdownFile(filePath);
    if (!content) {
      continue;
    }

    const title = SECTION_TITLES[filename] || filename;
    sections.push(`# ${title}\n\n${content}`);
  }

  if (shouldIncludeMemory(conversationText)) {
    for (const filename of OPTIONAL_PROMPT_FILE_ORDER) {
      const filePath = path.join(workdir, filename);
      const content = readMarkdownFile(filePath);
      if (!content) {
        continue;
      }

      sections.push(`# ${filename}\n\n${content}`);
    }
  }

  return sections;
}

function buildBootstrapBlock(workdir: string, sandbox: string): string | null {
  const bootstrapPath = path.join(workdir, "BOOTSTRAP.md");
  const bootstrapContent = readMarkdownFile(bootstrapPath);
  if (!bootstrapContent) {
    return null;
  }

  const persistenceHint =
    sandbox === "read-only"
      ? "当前 sandbox 是 read-only，不能写回文件。告诉用户：引导可以先完成，但需要可写权限才能持久保存到 PROFILE.md / MEMORY.md / SOUL.md。"
      : "当前 sandbox 允许写入。拿到稳定信息后直接更新工作目录中的 PROFILE.md / MEMORY.md / SOUL.md，不要只记在聊天上下文里。";

  return [
    "# BOOTSTRAP MODE",
    "",
    "工作目录里存在 `BOOTSTRAP.md`，说明当前仍处于首次引导阶段。",
    "当用户第一次打招呼、闲聊或只发一句很短的话时，不要只回通用客服式寒暄。",
    "你应该简短地自我介绍，然后自然地推进 1 到 2 个引导问题，例如用户名字、希望怎么称呼、偏好的语言和协作方式。",
    "如果用户这轮明确要直接处理任务，也可以先帮他做事，但要保持温和，并在合适时机继续完成引导。",
    persistenceHint,
    "当你已经收集到足够的长期信息并写回文件后，删除工作目录里的 `BOOTSTRAP.md`，表示引导完成。",
    "",
    "# BOOTSTRAP.md",
    "",
    bootstrapContent,
  ].join("\n");
}

export function buildSystemPrompt(options: {
  workdir: string;
  sandbox: string;
  extraPrompt?: string;
  templateDir?: string;
  conversationText?: string;
  skillsDir?: string;
}): string {
  const templateDir = resolvePromptDir(options.templateDir);
  ensureWorkspacePromptFiles(options.workdir, templateDir);

  const parts = [
    `[环境] 工作目录=${options.workdir} sandbox=${options.sandbox}`,
  ];

  if (options.extraPrompt?.trim()) {
    parts.push(options.extraPrompt.trim());
  }

  const sections = loadPromptSections(
    options.workdir,
    options.conversationText,
  );
  if (sections.length > 0) {
    parts.push(sections.join("\n\n"));
  }

  if (options.skillsDir?.trim()) {
    const skillsSection = buildSkillsPromptSection(options.skillsDir);
    if (skillsSection) {
      parts.push(skillsSection);
    }
  }

  const bootstrapBlock = buildBootstrapBlock(
    options.workdir,
    options.sandbox,
  );
  if (bootstrapBlock) {
    parts.push(bootstrapBlock);
  }

  return parts.join("\n\n");
}
