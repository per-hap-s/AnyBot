import { existsSync, statSync } from "node:fs";
import path from "node:path";

import type {
  ReplyPayload,
  TextMessageContent,
  ImageMessageContent,
  FileMessageContent,
} from "./types.js";

export function parseIncomingText(content: string): string {
  try {
    const parsed = JSON.parse(content) as TextMessageContent;
    return (parsed.text || "").trim();
  } catch {
    return content.trim();
  }
}

export function sanitizeUserText(text: string): string {
  return text.replace(/<at[^>]*>.*?<\/at>/g, "").trim();
}

export function parseIncomingImageKey(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as ImageMessageContent;
    return parsed.image_key?.trim() || null;
  } catch {
    return null;
  }
}

export function parseIncomingFileInfo(
  content: string,
): { fileKey: string; fileName: string | null } | null {
  try {
    const parsed = JSON.parse(content) as FileMessageContent;
    const fileKey = parsed.file_key?.trim();
    if (!fileKey) {
      return null;
    }

    return {
      fileKey,
      fileName: parsed.file_name?.trim() || null,
    };
  } catch {
    return null;
  }
}

const SUPPORTED_FEISHU_DOCUMENT_EXTS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".csv",
  ".tsv",
  ".txt",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".sh",
  ".ps1",
  ".sql",
]);

const ARCHIVE_EXTS = new Set([
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
]);

const EXECUTABLE_EXTS = new Set([
  ".exe",
  ".msi",
  ".bat",
  ".cmd",
  ".com",
  ".apk",
]);

const MEDIA_EXTS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
]);

const BINARY_EXTS = new Set([
  ".bin",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".iso",
  ".dmg",
  ".img",
  ".dll",
  ".so",
  ".dat",
]);

export type UnsupportedFeishuFileCategory =
  | "archive"
  | "executable"
  | "media"
  | "binary"
  | "unknown";

export function getSupportedFeishuDocumentExts(): string[] {
  return [...SUPPORTED_FEISHU_DOCUMENT_EXTS].sort();
}

export function isSupportedFeishuDocumentFileName(fileName: string): boolean {
  return SUPPORTED_FEISHU_DOCUMENT_EXTS.has(path.extname(fileName).toLowerCase());
}

export function classifyUnsupportedFeishuFileName(fileName: string): UnsupportedFeishuFileCategory {
  const ext = path.extname(fileName).toLowerCase();
  if (!ext) {
    return "unknown";
  }
  if (ARCHIVE_EXTS.has(ext)) {
    return "archive";
  }
  if (EXECUTABLE_EXTS.has(ext)) {
    return "executable";
  }
  if (MEDIA_EXTS.has(ext)) {
    return "media";
  }
  if (BINARY_EXTS.has(ext)) {
    return "binary";
  }
  return "unknown";
}

export function buildUnsupportedFeishuFileMessage(fileName: string): string {
  const safeName = sanitizeIncomingFileName(fileName);
  const supported = getSupportedFeishuDocumentExts().join(", ");
  const category = classifyUnsupportedFeishuFileName(safeName);

  switch (category) {
    case "archive":
      return [
        `暂时不直接解析压缩包文件：\`${safeName}\``,
        "",
        "建议先解压后发送其中的具体文件。",
        `优先支持：${supported}`,
        "如果你不确定该发哪个文件，可以告诉我压缩包里大概有什么。",
      ].join("\n");
    case "executable":
      return [
        `暂时不直接分析可执行或安装文件：\`${safeName}\``,
        "",
        "建议改发相关日志、配置文件、报错截图，或者对应源码文件。",
        `常见可读格式：${supported}`,
      ].join("\n");
    case "media":
      return [
        `暂时不直接理解音频或视频附件：\`${safeName}\``,
        "",
        "建议先提供文字稿、字幕、关键截图，或转成文本说明后再发。",
        "如果是录屏问题，也可以直接发关键截图配合描述。",
      ].join("\n");
    case "binary":
      return [
        `暂时不直接解析二进制或镜像类文件：\`${safeName}\``,
        "",
        "建议先导出为 `.csv`、`.sql`、`.json`、`.txt` 等可读格式后再发送。",
        `当前优先支持：${supported}`,
      ].join("\n");
    default:
      return [
        `暂时无法直接理解这个附件类型：\`${safeName}\``,
        "",
        `建议优先改发这些格式：${supported}`,
        "如果你不知道怎么转换，可以告诉我这个文件是做什么的，我会建议最合适的替代格式。",
      ].join("\n");
  }
}

export function sanitizeIncomingFileName(fileName: string | null | undefined): string {
  const fallback = "incoming-file";
  const trimmed = (fileName || "").trim();
  if (!trimmed) {
    return fallback;
  }

  const baseName = path.basename(trimmed).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  return baseName || fallback;
}

export function getImageExtension(contentType?: string): string {
  switch ((contentType || "").split(";")[0].trim().toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/tiff":
      return ".tiff";
    case "image/bmp":
      return ".bmp";
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return ".ico";
    default:
      return ".img";
  }
}

const SUPPORTED_IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".tiff",
  ".tif",
  ".bmp",
  ".ico",
]);

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

export function isSupportedImagePath(filePath: string): boolean {
  return SUPPORTED_IMAGE_EXTS.has(path.extname(filePath).toLowerCase());
}

export function normalizeCandidateImagePath(
  filePath: string,
  workdir: string,
): string | null {
  const normalized = filePath.trim();
  if (!normalized || !isSupportedImagePath(normalized)) {
    return null;
  }

  const resolved = path.isAbsolute(normalized) || isWindowsAbsolutePath(normalized)
    ? normalized
    : path.resolve(workdir, normalized);

  return existsSync(resolved) ? resolved : null;
}

function unwrapPathToken(raw: string): string {
  const trimmed = raw.trim();
  const markdownLinkMatch = trimmed.match(/^\[[^\]]*]\(([^)\n]+)\)$/);
  const value = (markdownLinkMatch?.[1] || trimmed).trim();

  if (
    (value.startsWith("`") && value.endsWith("`")) ||
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function tryResolveExistingFilePath(candidate: string, workdir: string): string | null {
  const resolved = path.isAbsolute(candidate) || isWindowsAbsolutePath(candidate)
    ? candidate
    : path.resolve(workdir, candidate);
  if (!existsSync(resolved)) {
    return null;
  }
  try {
    return statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

export function normalizeCandidateFilePath(filePath: string, workdir: string): string | null {
  const normalized = unwrapPathToken(filePath);
  if (!normalized || isSupportedImagePath(normalized)) {
    return null;
  }

  const direct = tryResolveExistingFilePath(normalized, workdir);
  if (direct) {
    return direct;
  }

  if (!isWindowsAbsolutePath(normalized)) {
    const withoutLine = normalized.replace(/:(\d+)(:\d+)?$/, "");
    if (withoutLine !== normalized) {
      return tryResolveExistingFilePath(withoutLine, workdir);
    }
  }

  return null;
}

export function parseReplyPayload(reply: string, workdir: string): ReplyPayload {
  const imagePaths = new Set<string>();
  const filePaths = new Set<string>();

  const markdownImagePattern = /!\[[^\]]*]\(([^)\n]+)\)/g;
  for (const match of reply.matchAll(markdownImagePattern)) {
    const imagePath = normalizeCandidateImagePath(match[1] || "", workdir);
    if (imagePath) {
      imagePaths.add(imagePath);
    }
  }

  const plainPathPattern =
    /(^|\n)((?:[a-zA-Z]:[\\/]|\.{0,2}[\\/])[^\s<>"')\]]+\.(?:png|jpe?g|webp|gif|tiff?|bmp|ico))(?=\n|$)/gi;
  for (const match of reply.matchAll(plainPathPattern)) {
    const imagePath = normalizeCandidateImagePath(match[2] || "", workdir);
    if (imagePath) {
      imagePaths.add(imagePath);
    }
  }

  const inlineCodePathPattern = /`([^`\n]+\.(?:png|jpe?g|webp|gif|tiff?|bmp|ico))`/gi;
  for (const match of reply.matchAll(inlineCodePathPattern)) {
    const imagePath = normalizeCandidateImagePath(match[1] || "", workdir);
    if (imagePath) {
      imagePaths.add(imagePath);
    }
  }

  const fileDirectivePattern = /(^|\n)\s*FILE:\s*([^\n]+)(?=\n|$)/gi;
  for (const match of reply.matchAll(fileDirectivePattern)) {
    const filePath = normalizeCandidateFilePath(match[2] || "", workdir);
    if (filePath) {
      filePaths.add(filePath);
    }
  }

  let text = reply.replace(markdownImagePattern, (fullMatch, imgPath: string) => {
    return normalizeCandidateImagePath(imgPath, workdir) ? "" : fullMatch;
  });
  text = text.replace(plainPathPattern, (fullMatch, prefix: string, imgPath: string) => {
    return normalizeCandidateImagePath(imgPath, workdir) ? prefix : fullMatch;
  });
  text = text.replace(inlineCodePathPattern, (fullMatch, imgPath: string) => {
    return normalizeCandidateImagePath(imgPath, workdir) ? "" : fullMatch;
  });
  text = text.replace(fileDirectivePattern, (fullMatch, prefix: string, filePath: string) => {
    return normalizeCandidateFilePath(filePath, workdir) ? prefix : fullMatch;
  });
  text = text.trim().replace(/\n{3,}/g, "\n\n");

  return {
    text,
    imagePaths: [...imagePaths],
    filePaths: [...filePaths],
  };
}
