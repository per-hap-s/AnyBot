import { buildSkillsPromptSection } from "./skills.js";

export function buildSystemPrompt(options: {
  workdir: string;
  sandbox: string;
  extraPrompt?: string;
  skillsDir?: string;
}): string {
  const parts = [
    `[环境] 工作目录=${options.workdir} sandbox=${options.sandbox}`,
  ];

  if (options.extraPrompt?.trim()) {
    parts.push(options.extraPrompt.trim());
  }

  if (options.skillsDir?.trim()) {
    const skillsSection = buildSkillsPromptSection(options.skillsDir);
    if (skillsSection) {
      parts.push(skillsSection);
    }
  }

  return parts.join("\n\n");
}
