export interface ServiceStatusPayload {
  ok: true;
  app: "anybot";
  version: string;
  pid: number;
  webHost?: string;
  webPort: number;
  provider: string;
  currentModel: string;
  workdir: string;
  sandbox: string;
  channels: {
    registered: string[];
    running: string[];
    feishuEnabled: boolean;
    telegramEnabled: boolean;
  };
  startedAt: number;
}
