export type TextMessageContent = {
  text?: string;
};

export type ImageMessageContent = {
  image_key?: string;
};

export type FileMessageContent = {
  file_key?: string;
  file_name?: string;
};

export type IncomingMessage = {
  message_id: string;
  chat_id: string;
  message_type: string;
  content: string;
};

export type ReplyPayload = {
  text: string;
  imagePaths: string[];
  filePaths: string[];
};

export const sandboxModes = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

export type SandboxMode = (typeof sandboxModes)[number];

export type CodexJsonEvent = {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
  };
};
