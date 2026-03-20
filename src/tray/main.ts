import "../env-bootstrap.js";

import { randomUUID } from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnSyncReturns,
} from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  app,
  Menu,
  Notification,
  Tray,
  clipboard,
  dialog,
  nativeImage,
  shell,
  type MenuItemConstructorOptions,
} from "electron";

import { readChannelConfig, updateChannelConfig } from "../channels/config.js";
import type { TelegramChannelConfig, TelegramFinalReplyMode } from "../channels/types.js";
import { CONTROL_TOKEN_HEADER, readControlToken } from "../control-token.js";
import { getDataDir, getRunDir } from "../runtime-paths.js";
import type { ServiceStatusPayload } from "../service-status.js";

type ServiceState = "stopped" | "starting" | "running" | "error" | "restarting";

type ProbeResult =
  | { kind: "anybot"; status: ServiceStatusPayload }
  | { kind: "free" }
  | { kind: "conflict" };

type WaitForReadyResult =
  | { ok: true; status: ServiceStatusPayload }
  | { ok: false; reason: "timeout" | "conflict" | "exit" };

type TrayConfig = {
  launchAtLogin: boolean;
  serviceAutoStartOnLogin: boolean;
  serviceAutoStartDelaySeconds: number;
};

type TrayLaunchContext = {
  launchedHidden: boolean;
  forceStartService: boolean;
};

type LoginItemSettingsOptions = {
  openAtLogin?: boolean;
  openAsHidden?: boolean;
  path: string;
  args: string[];
};

const DEFAULT_PORT = parseInt(process.env.WEB_PORT || "19981", 10);
const STATUS_POLL_MS = 5000;
const START_TIMEOUT_MS = 20000;
const FAILURE_WINDOW_MS = 2 * 60 * 1000;
const RESTART_DELAYS_MS = [3000, 10000];
const DEFAULT_SERVICE_AUTO_START_DELAY_SECONDS = 0;
const SUMMARY_MAX_LENGTH = 64;
const WORKDIR_MAX_LENGTH = 68;
const ERROR_MAX_LENGTH = 42;
const DEFAULT_TELEGRAM_FINAL_REPLY_MODE: TelegramFinalReplyMode = "replace";
const HIDDEN_ARG = "--hidden";
const START_SERVICE_ARG = "--start-service";
const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_LOGIN_ITEM_NAME = "AnyBotTray";
const WINDOWS_LEGACY_LOGIN_ITEM_NAMES = ["electron.app.Electron", "AnyBot"];

let trayInstance: Tray | null = null;
let serviceManagerInstance: ServiceManager | null = null;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK_APP_ROOT = path.resolve(MODULE_DIR, "..", "..", "..");

function getAppRoot(): string {
  try {
    const electronAppPath = app.getAppPath();
    if (existsSync(path.join(electronAppPath, "package.json"))) {
      return electronAppPath;
    }
  } catch {
    // Fall back to the current module path when Electron has not resolved the app root yet.
  }

  return FALLBACK_APP_ROOT;
}

function getRuntimeRoot(): string {
  return app.isPackaged ? app.getPath("userData") : getAppRoot();
}

function getTrayConfigPath(runtimeRoot: string): string {
  return path.join(getDataDir(runtimeRoot), "tray-config.json");
}

function getDefaultTrayConfig(): TrayConfig {
  return {
    launchAtLogin: true,
    serviceAutoStartOnLogin: true,
    serviceAutoStartDelaySeconds: DEFAULT_SERVICE_AUTO_START_DELAY_SECONDS,
  };
}

function normalizeAutoStartDelaySeconds(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.trunc(value);
  if (normalized < 0) {
    return 0;
  }

  return Math.min(normalized, 3600);
}

function readTrayConfig(runtimeRoot: string): TrayConfig {
  const configPath = getTrayConfigPath(runtimeRoot);
  const defaultConfig = getDefaultTrayConfig();
  let nextConfig = defaultConfig;

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw) as Partial<TrayConfig>;
      nextConfig = {
        launchAtLogin:
          typeof parsed.launchAtLogin === "boolean"
            ? parsed.launchAtLogin
            : defaultConfig.launchAtLogin,
        serviceAutoStartOnLogin:
          typeof parsed.serviceAutoStartOnLogin === "boolean"
            ? parsed.serviceAutoStartOnLogin
            : defaultConfig.serviceAutoStartOnLogin,
        serviceAutoStartDelaySeconds: normalizeAutoStartDelaySeconds(
          parsed.serviceAutoStartDelaySeconds,
          defaultConfig.serviceAutoStartDelaySeconds,
        ),
      };
    } catch {
      nextConfig = defaultConfig;
    }
  }

  writeTrayConfig(runtimeRoot, nextConfig);
  return nextConfig;
}

function writeTrayConfig(runtimeRoot: string, config: TrayConfig): void {
  const configPath = getTrayConfigPath(runtimeRoot);
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

function buildServiceUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function getTrayIconPath(state: ServiceState): string {
  return path.join(getAppRoot(), "assets", "icons", `tray-${state}.ico`);
}

function truncateValue(value: string, max = 54): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function formatEnabledLabel(enabled: boolean): string {
  return enabled ? "开" : "关";
}

function formatTelegramFinalReplyModeLabel(mode: TelegramFinalReplyMode): string {
  return mode === "replace_and_notify" ? "原地替换并提醒" : "原地替换";
}

function formatSummary(status: ServiceStatusPayload | null, port: number): string {
  const summaryParts = [`端口 ${port}`];
  if (status?.currentModel) {
    summaryParts.push(`模型 ${status.currentModel}`);
  }

  return truncateValue(summaryParts.join(" | "), SUMMARY_MAX_LENGTH);
}

function createTrayImage(state: ServiceState): Electron.NativeImage {
  const iconPath = getTrayIconPath(state);
  if (existsSync(iconPath)) {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      return icon;
    }
  }

  const colors: Record<ServiceState, string> = {
    stopped: "#7f8c8d",
    starting: "#d39b22",
    running: "#2fa76d",
    error: "#d64545",
    restarting: "#c97a10",
  };

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <defs>
        <linearGradient id="brandGradient" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#dd7742" />
          <stop offset="100%" stop-color="#94351d" />
        </linearGradient>
      </defs>
      <rect x="5" y="5" width="54" height="54" rx="16" fill="url(#brandGradient)" />
      <polygon points="32,10 50,28 32,46 14,28" fill="#fffdf7" />
      <polygon points="32,19 41,28 32,37 23,28" fill="url(#brandGradient)" />
      <circle cx="50" cy="50" r="9" fill="#fffaf2" />
      <circle cx="50" cy="50" r="6" fill="${colors[state]}" />
    </svg>
  `.trim();

  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  );
}

function getLaunchContext(): TrayLaunchContext {
  return {
    launchedHidden: process.argv.includes(HIDDEN_ARG),
    forceStartService: process.argv.includes(START_SERVICE_ARG),
  };
}

function buildLoginItemSettings(enabled?: boolean): LoginItemSettingsOptions {
  const loginArgs = app.isPackaged ? [HIDDEN_ARG] : [getAppRoot(), HIDDEN_ARG];
  return {
    ...(enabled === undefined ? {} : { openAtLogin: enabled, openAsHidden: true }),
    path: process.execPath,
    args: loginArgs,
  };
}

function buildWindowsLoginCommand(): string {
  const segments = [`"${process.execPath}"`];
  if (!app.isPackaged) {
    segments.push(`"${getAppRoot()}"`);
  }
  segments.push(HIDDEN_ARG);
  return segments.join(" ");
}

function runRegistryCommand(args: string[]): SpawnSyncReturns<string> {
  return spawnSync("reg", args, {
    encoding: "utf-8",
    windowsHide: true,
  });
}

function removeWindowsRunValue(name: string): void {
  runRegistryCommand(["delete", WINDOWS_RUN_KEY, "/v", name, "/f"]);
}

function setWindowsAutoLaunch(enabled: boolean): boolean | null {
  if (process.platform !== "win32") {
    return null;
  }

  for (const legacyName of WINDOWS_LEGACY_LOGIN_ITEM_NAMES) {
    removeWindowsRunValue(legacyName);
  }

  if (!enabled) {
    removeWindowsRunValue(WINDOWS_LOGIN_ITEM_NAME);
    return readWindowsAutoLaunchEnabled();
  }

  const result = runRegistryCommand([
    "add",
    WINDOWS_RUN_KEY,
    "/v",
    WINDOWS_LOGIN_ITEM_NAME,
    "/t",
    "REG_SZ",
    "/d",
    buildWindowsLoginCommand(),
    "/f",
  ]);
  if (result.status !== 0) {
    return null;
  }

  return readWindowsAutoLaunchEnabled();
}

function readWindowsAutoLaunchEnabled(): boolean | null {
  if (process.platform !== "win32") {
    return null;
  }

  const result = runRegistryCommand(["query", WINDOWS_RUN_KEY, "/v", WINDOWS_LOGIN_ITEM_NAME]);
  if (result.status === 0) {
    return true;
  }

  for (const legacyName of WINDOWS_LEGACY_LOGIN_ITEM_NAMES) {
    const legacyResult = runRegistryCommand(["query", WINDOWS_RUN_KEY, "/v", legacyName]);
    if (legacyResult.status === 0) {
      return true;
    }
  }

  return false;
}

class TrayLogger {
  private readonly logPath: string;

  constructor(private readonly runDir: string) {
    mkdirSync(runDir, { recursive: true });
    this.logPath = path.join(runDir, "tray.log");
  }

  log(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...(context ? { ctx: context } : {}),
    });
    appendFileSync(this.logPath, `${line}\n`, "utf-8");
  }
}

class ServiceManager {
  private tray: Tray | null = null;
  private readonly runDir: string;
  private readonly serviceStdIoPath: string;
  private state: ServiceState = "stopped";
  private lastError: string | null = null;
  private currentStatus: ServiceStatusPayload | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private controlToken: string | null = null;
  private attached = false;
  private quitting = false;
  private manualStop = false;
  private statusTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private startupDelayTimer: NodeJS.Timeout | null = null;
  private failureTimestamps: number[] = [];
  private trayConfig: TrayConfig;

  constructor(
    private readonly appRoot: string,
    private readonly runtimeRoot: string,
    private readonly logger: TrayLogger,
    private readonly port: number,
    private readonly launchContext: TrayLaunchContext,
  ) {
    this.runDir = getRunDir(runtimeRoot);
    this.serviceStdIoPath = path.join(this.runDir, "service-stdio.log");
    this.trayConfig = readTrayConfig(runtimeRoot);
  }

  attachTray(tray: Tray): void {
    this.tray = tray;
    this.tray.setToolTip("AnyBot");
    this.tray.on("double-click", () => {
      void this.openUi();
    });
    this.renderTray();
  }

  async initialize(): Promise<void> {
    this.applyLoginItemSetting(this.trayConfig.launchAtLogin);
    const trayAutoLaunchEnabled = this.getTrayAutoLaunchEnabled();
    if (trayAutoLaunchEnabled !== this.trayConfig.launchAtLogin) {
      this.persistTrayConfig({
        ...this.trayConfig,
        launchAtLogin: trayAutoLaunchEnabled,
      });
    }

    const probe = await this.probeService();
    if (probe.kind === "anybot") {
      this.setRunning(probe.status, true);
      this.startPolling();
      return;
    }

    if (probe.kind === "conflict") {
      this.setState("error", `端口 ${this.port} 已被其他程序占用。`);
      this.startPolling();
      return;
    }

    if (this.shouldAutoStartServiceOnLaunch()) {
      if (this.launchContext.forceStartService) {
        await this.startService("manual");
      } else {
        this.scheduleAutoStartServiceOnLaunch();
      }
    } else {
      this.setState("stopped", null);
    }

    this.startPolling();
  }

  async exitApplication(): Promise<void> {
    this.quitting = true;
    this.clearTimers();

    if (this.canControlCurrentInstance()) {
      await this.stopService(true);
    }

    app.quit();
  }

  private shouldAutoStartServiceOnLaunch(): boolean {
    if (this.launchContext.forceStartService) {
      return true;
    }

    return this.launchContext.launchedHidden && this.trayConfig.serviceAutoStartOnLogin;
  }

  private startPolling(): void {
    this.statusTimer = setInterval(() => {
      void this.refreshStatus();
    }, STATUS_POLL_MS);
  }

  private clearStartupDelayTimer(): void {
    if (this.startupDelayTimer) {
      clearTimeout(this.startupDelayTimer);
      this.startupDelayTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearStartupDelayTimer();
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private setState(state: ServiceState, errorMessage?: string | null): void {
    this.state = state;
    if (errorMessage !== undefined) {
      this.lastError = errorMessage;
    }
    this.renderTray();
  }

  private setRunning(status: ServiceStatusPayload, attached: boolean): void {
    this.currentStatus = status;
    this.attached = attached;
    this.lastError = null;
    this.failureTimestamps = [];
    this.controlToken = readControlToken(this.runtimeRoot) || this.controlToken;
    this.setState("running", null);
  }

  private renderTray(): void {
    if (!this.tray) {
      return;
    }

    this.tray.setImage(createTrayImage(this.state));
    this.tray.setToolTip(`AnyBot：${this.getStateLabel()}`);
    this.tray.setContextMenu(Menu.buildFromTemplate(this.buildMenuTemplate()));
  }

  private buildMenuTemplate(): MenuItemConstructorOptions[] {
    const status = this.currentStatus;
    const items: MenuItemConstructorOptions[] = [
      {
        label: `AnyBot：${this.getStateLabel()}`,
        enabled: false,
      },
      {
        label: formatSummary(status, this.port),
        enabled: false,
      },
    ];

    if (status) {
      items.push(
        {
          label: `飞书启用：${formatEnabledLabel(status.channels.feishuEnabled)}`,
          enabled: false,
        },
        {
          label: `TG 启用：${formatEnabledLabel(status.channels.telegramEnabled)}`,
          enabled: false,
        },
      );
    }

    const telegramFinalReplyMode = this.getTelegramFinalReplyMode();
    items.push({
      label: `TG 最终回复：${formatTelegramFinalReplyModeLabel(telegramFinalReplyMode)}`,
      submenu: [
        {
          label: "原地替换",
          type: "radio",
          checked: telegramFinalReplyMode === "replace",
          click: () => {
            void this.setTelegramFinalReplyMode("replace");
          },
        },
        {
          label: "原地替换并提醒",
          type: "radio",
          checked: telegramFinalReplyMode === "replace_and_notify",
          click: () => {
            void this.setTelegramFinalReplyMode("replace_and_notify");
          },
        },
      ],
    });

    if (status?.workdir) {
      items.push({
        label: `工作目录：${truncateValue(status.workdir, WORKDIR_MAX_LENGTH)}`,
        enabled: false,
      });
    }

    items.push({
      label: `托盘开机自启：${this.getTrayAutoLaunchLabel()} | AnyBot 开机自启：${this.getServiceAutoStartLabel()} | 延迟：${this.getServiceAutoStartDelayLabel()}`,
      enabled: false,
    });

    if (this.lastError) {
      items.push({
        label: `最近错误：${truncateValue(this.lastError, ERROR_MAX_LENGTH)}`,
        enabled: false,
      });
    }

    items.push(
      { type: "separator" },
      {
        label: "打开界面",
        click: () => {
          void this.openUi();
        },
      },
      {
        label: "复制地址",
        click: () => {
          clipboard.writeText(buildServiceUrl(this.port));
        },
      },
    );

    const canRestartService =
      this.state === "stopped" ||
      this.state === "error" ||
      this.canControlCurrentInstance();

    if (this.state === "stopped" || this.state === "error") {
      items.push({
        label: "启动 AnyBot 服务",
        click: () => {
          void this.startService("manual");
        },
      });
    }

    items.push({
      label: "重启 AnyBot 服务",
      enabled: canRestartService,
      click: () => {
        void this.restartService();
      },
    });

    if (this.state === "running" || this.state === "starting" || this.state === "restarting") {
      items.push({
        label: "停止 AnyBot 服务",
        enabled: this.canControlCurrentInstance(),
        click: () => {
          void this.stopService(true);
        },
      });
    }

    items.push(
      {
        label: "重启托盘",
        click: () => {
          void this.confirmRestartTray();
        },
      },
      {
        label: "打开日志目录",
        click: () => {
          void shell.openPath(this.runDir);
        },
      },
      {
        label: "托盘开机自启",
        type: "checkbox",
        checked: this.getTrayAutoLaunchEnabled(),
        click: () => {
          this.toggleTrayAutoLaunch();
        },
      },
      {
        label: "AnyBot 开机自启",
        type: "checkbox",
        checked: this.getServiceAutoStartOnLoginEnabled(),
        click: () => {
          this.toggleServiceAutoStartOnLogin();
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          void this.exitApplication();
        },
      },
    );

    return items;
  }

  private getStateLabel(): string {
    switch (this.state) {
      case "starting":
        return "启动中";
      case "running":
        return "运行中";
      case "restarting":
        return "重启中";
      case "error":
        return "异常";
      default:
        return "已停止";
    }
  }

  private getTrayAutoLaunchEnabled(): boolean {
    const windowsEnabled = readWindowsAutoLaunchEnabled();
    if (windowsEnabled !== null) {
      return windowsEnabled;
    }

    try {
      return app.getLoginItemSettings(buildLoginItemSettings()).openAtLogin;
    } catch {
      return this.trayConfig.launchAtLogin;
    }
  }

  private getTrayAutoLaunchLabel(): string {
    return this.getTrayAutoLaunchEnabled() ? "开" : "关";
  }

  private getServiceAutoStartOnLoginEnabled(): boolean {
    return this.trayConfig.serviceAutoStartOnLogin;
  }

  private getServiceAutoStartLabel(): string {
    return this.getServiceAutoStartOnLoginEnabled() ? "开" : "关";
  }

  private getServiceAutoStartDelaySeconds(): number {
    return this.trayConfig.serviceAutoStartDelaySeconds;
  }

  private getServiceAutoStartDelayLabel(): string {
    return `${this.getServiceAutoStartDelaySeconds()} 秒`;
  }

  private getTelegramFinalReplyMode(): TelegramFinalReplyMode {
    const config = readChannelConfig<TelegramChannelConfig>("telegram");
    return config?.finalReplyMode === "replace_and_notify"
      ? "replace_and_notify"
      : DEFAULT_TELEGRAM_FINAL_REPLY_MODE;
  }

  private async setTelegramFinalReplyMode(mode: TelegramFinalReplyMode): Promise<void> {
    const currentMode = this.getTelegramFinalReplyMode();
    if (currentMode === mode) {
      return;
    }

    const updated = await this.updateTelegramConfig({ finalReplyMode: mode });
    this.renderTray();
    if (!updated) {
      this.notify("AnyBot", "Telegram 最终回复模式更新失败。");
    }
  }

  private async updateTelegramConfig(partial: Partial<TelegramChannelConfig>): Promise<boolean> {
    if (this.state === "running" && this.currentStatus) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(`${buildServiceUrl(this.port)}/api/channels/telegram`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(partial),
          signal: controller.signal,
        });
        if (response.ok) {
          return true;
        }
      } catch {
        // Fall back to direct config-file update when the service API is unavailable.
      } finally {
        clearTimeout(timer);
      }
    }

    try {
      updateChannelConfig("telegram", partial);
      return true;
    } catch (error) {
      this.logger.log("warn", "tray.telegram_config_update_failed", {
        error: error instanceof Error ? error.message : String(error),
        partial,
      });
      return false;
    }
  }

  private applyLoginItemSetting(enabled: boolean): void {
    let windowsApplied: boolean | null = null;
    if (process.platform === "win32") {
      windowsApplied = setWindowsAutoLaunch(enabled);
    }

    app.setLoginItemSettings(buildLoginItemSettings(enabled));

    if (windowsApplied === null && process.platform === "win32") {
      this.logger.log("warn", "tray.autostart.registry_failed", {
        enabled,
      });
    }
  }

  private persistTrayConfig(nextConfig: TrayConfig): void {
    this.trayConfig = nextConfig;
    writeTrayConfig(this.runtimeRoot, nextConfig);
    this.renderTray();
  }

  private toggleTrayAutoLaunch(): void {
    const enabled = !this.getTrayAutoLaunchEnabled();
    this.applyLoginItemSetting(enabled);
    const actualEnabled = this.getTrayAutoLaunchEnabled();
    this.persistTrayConfig({
      ...this.trayConfig,
      launchAtLogin: actualEnabled,
    });

    if (actualEnabled !== enabled) {
      this.notify("AnyBot", "托盘开机自启设置未成功应用。");
    }
  }

  private toggleServiceAutoStartOnLogin(): void {
    if (this.trayConfig.serviceAutoStartOnLogin) {
      this.clearStartupDelayTimer();
    }
    this.persistTrayConfig({
      ...this.trayConfig,
      serviceAutoStartOnLogin: !this.trayConfig.serviceAutoStartOnLogin,
    });
  }

  async openUi(): Promise<void> {
    if (this.state !== "running") {
      await this.startService("manual");
    }
    if (this.state === "running") {
      await shell.openExternal(buildServiceUrl(this.port));
    }
  }

  private async confirmRestartTray(): Promise<void> {
    const result = await dialog.showMessageBox({
      type: "question",
      buttons: ["仅重启托盘", "重启托盘并重启 AnyBot", "取消"],
      cancelId: 2,
      defaultId: 0,
      noLink: true,
      title: "重启托盘",
      message: "请选择重启方式",
      detail: "仅重启托盘会保留当前 AnyBot 服务；另一项会一起重启 AnyBot 服务。",
    });

    if (result.response === 0) {
      await this.restartTray(false);
      return;
    }

    if (result.response === 1) {
      await this.restartTray(true);
    }
  }

  private relaunchTray(args: string[]): void {
    const currentArgs = process.argv
      .slice(1)
      .filter((arg) => arg !== HIDDEN_ARG && arg !== START_SERVICE_ARG);
    app.relaunch({
      args: [...currentArgs, ...args],
    });
  }

  private async restartTray(restartService: boolean): Promise<void> {
    this.quitting = true;
    this.clearTimers();

    if (restartService) {
      await this.stopService(true);
      this.relaunchTray([START_SERVICE_ARG]);
    } else {
      this.relaunchTray([]);
    }

    app.quit();
  }

  async restartService(): Promise<void> {
    if (this.state === "stopped" || this.state === "error") {
      await this.startService("manual");
      return;
    }

    await this.stopService(true);
    await this.startService("manual");
  }

  async stopService(manual: boolean): Promise<void> {
    this.manualStop = manual;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.state === "stopped") {
      return;
    }

    if (!this.canControlCurrentInstance()) {
      this.setState("error", "当前实例无法由托盘控制。");
      return;
    }

    try {
      const shutdownOk = await this.requestShutdown();
      if (!shutdownOk && this.child) {
        this.child.kill();
      }
    } catch (error) {
      this.logger.log("warn", "service.stop.request_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.child) {
        this.child.kill();
      }
    }

    const stopped = await this.waitForServiceDown(15000);
    if (!stopped && this.child) {
      this.child.kill();
      await this.waitForServiceDown(5000);
    }

    this.currentStatus = null;
    this.attached = false;
    this.child = null;
    this.setState("stopped", null);
  }

  private scheduleAutoStartServiceOnLaunch(): void {
    this.clearStartupDelayTimer();

    const delaySeconds = this.getServiceAutoStartDelaySeconds();
    if (delaySeconds <= 0) {
      void this.startService("startup");
      return;
    }

    this.setState("stopped", null);
    this.logger.log("info", "service.autostart_scheduled", {
      delaySeconds,
      port: this.port,
    });

    this.startupDelayTimer = setTimeout(() => {
      this.startupDelayTimer = null;
      void this.startService("startup");
    }, delaySeconds * 1000);
  }

  async startService(trigger: "startup" | "manual" | "restart"): Promise<void> {
    if (this.quitting || this.state === "starting" || this.state === "restarting") {
      return;
    }

    this.clearStartupDelayTimer();

    const probe = await this.probeService();
    if (probe.kind === "anybot") {
      this.setRunning(probe.status, true);
      return;
    }

    if (probe.kind === "conflict") {
      const message = `端口 ${this.port} 已被其他程序占用。`;
      this.setState("error", message);
      if (trigger !== "startup") {
        this.notify("AnyBot", message);
      }
      return;
    }

    this.manualStop = false;
    this.controlToken = randomUUID();
    this.currentStatus = null;
    this.attached = false;
    this.setState(trigger === "restart" ? "restarting" : "starting", null);

    const spec = this.resolveServiceLaunchSpec();
    this.logger.log("info", "service.spawn", {
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      port: this.port,
    });

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: "pipe",
      windowsHide: true,
    });
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => {
      this.writeServiceOutput("stdout", chunk.toString("utf-8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.writeServiceOutput("stderr", chunk.toString("utf-8"));
    });
    child.once("error", (error) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      this.handleUnexpectedStop(`服务启动失败：${error.message}`);
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      this.currentStatus = null;
      this.attached = false;

      if (this.quitting) {
        return;
      }

      if (this.manualStop) {
        this.setState("stopped", null);
        return;
      }

      const reason = `服务异常退出（${signal || code || "unknown"}）`;
      this.handleUnexpectedStop(reason);
    });

    const ready = await this.waitForServiceReady(child, START_TIMEOUT_MS);
    if (ready.ok) {
      this.setRunning(ready.status, false);
      return;
    }

    if (this.child === child) {
      this.lastError =
        ready.reason === "conflict"
          ? `端口 ${this.port} 已被其他程序占用。`
          : "服务启动失败：未在预期时间内完成启动。";
      child.kill();
    }
  }

  private resolveServiceLaunchSpec(): {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  } {
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ANYBOT_RUNTIME_ROOT: this.runtimeRoot,
      ANYBOT_CONTROL_TOKEN: this.controlToken || randomUUID(),
      WEB_PORT: String(this.port),
      LOG_TO_STDOUT: "false",
      ELECTRON_RUN_AS_NODE: "1",
    };

    if (app.isPackaged) {
      return {
        command: process.execPath,
        args: [path.join(app.getAppPath(), "dist", "service", "index.js")],
        cwd: this.runtimeRoot,
        env: baseEnv,
      };
    }

    return {
      command: process.env.NODE_BINARY || "node",
      args: [
        path.join(this.appRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(this.appRoot, "src", "index.ts"),
      ],
      cwd: this.appRoot,
      env: baseEnv,
    };
  }

  private writeServiceOutput(stream: "stdout" | "stderr", text: string): void {
    mkdirSync(this.runDir, { recursive: true });
    const line = `[${new Date().toISOString()}] [${stream}] ${text}`;
    appendFileSync(this.serviceStdIoPath, line, "utf-8");
  }

  private canControlCurrentInstance(): boolean {
    return Boolean(this.child || readControlToken(this.runtimeRoot));
  }

  private async requestShutdown(): Promise<boolean> {
    const token = readControlToken(this.runtimeRoot) || this.controlToken;
    if (!token) {
      return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${buildServiceUrl(this.port)}/api/control/shutdown`, {
        method: "POST",
        headers: {
          [CONTROL_TOKEN_HEADER]: token,
        },
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async waitForServiceReady(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<WaitForReadyResult> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.fetchStatus();
      if (status) {
        return { ok: true, status };
      }

      if (child.exitCode !== null) {
        return { ok: false, reason: "exit" };
      }

      await delay(1000);
    }

    const probe = await this.probeService();
    if (probe.kind === "conflict") {
      return { ok: false, reason: "conflict" };
    }

    return { ok: false, reason: "timeout" };
  }

  private async waitForServiceDown(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const probe = await this.probeService();
      if (probe.kind === "free") {
        return true;
      }
      await delay(500);
    }
    return false;
  }

  private async refreshStatus(): Promise<void> {
    if (this.quitting) {
      return;
    }

    const probe = await this.probeService();
    if (probe.kind === "anybot") {
      this.currentStatus = probe.status;
      if (this.state !== "running") {
        this.setRunning(probe.status, !this.child);
      } else {
        this.renderTray();
      }
      return;
    }

    if (this.child) {
      return;
    }

    if (probe.kind === "conflict") {
      this.setState("error", `端口 ${this.port} 已被其他程序占用。`);
      return;
    }

    if (this.state === "running" && !this.manualStop) {
      this.handleUnexpectedStop("服务无响应，准备重启。");
      return;
    }

    if (!this.manualStop) {
      this.setState("stopped", null);
    }
  }

  private handleUnexpectedStop(reason: string): void {
    if (this.quitting || this.manualStop) {
      return;
    }

    const now = Date.now();
    this.failureTimestamps = this.failureTimestamps.filter(
      (timestamp) => now - timestamp < FAILURE_WINDOW_MS,
    );
    this.failureTimestamps.push(now);

    if (this.failureTimestamps.length >= 3) {
      const message = "服务连续启动失败，已停止自动重启。";
      this.setState("error", message);
      this.notify("AnyBot", message);
      return;
    }

    const delayMs = RESTART_DELAYS_MS[this.failureTimestamps.length - 1] || 30000;
    this.setState("restarting", reason);
    this.notify("AnyBot", `${reason}，将在 ${Math.round(delayMs / 1000)} 秒后重启。`);

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.startService("restart");
    }, delayMs);
  }

  private notify(title: string, body: string): void {
    if (!Notification.isSupported()) {
      return;
    }
    new Notification({ title, body }).show();
  }

  private async fetchStatus(): Promise<ServiceStatusPayload | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);

    try {
      const response = await fetch(`${buildServiceUrl(this.port)}/api/status`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as Partial<ServiceStatusPayload>;
      if (data.app !== "anybot" || data.ok !== true) {
        return null;
      }

      return data as ServiceStatusPayload;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async probeService(): Promise<ProbeResult> {
    const status = await this.fetchStatus();
    if (status) {
      return { kind: "anybot", status };
    }

    const free = await this.isPortFree();
    return free ? { kind: "free" } : { kind: "conflict" };
  }

  private async isPortFree(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => {
        resolve(false);
      });
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(this.port, "127.0.0.1");
    });
  }
}

async function bootstrap(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  const runtimeRoot = getRuntimeRoot();
  const runDir = getRunDir(runtimeRoot);
  const launchContext = getLaunchContext();
  mkdirSync(runDir, { recursive: true });
  const logger = new TrayLogger(runDir);

  app.on("second-instance", (_event, commandLine) => {
    const hidden = commandLine.includes(HIDDEN_ARG);
    if (!hidden) {
      void shell.openExternal(buildServiceUrl(DEFAULT_PORT));
    }
  });

  await app.whenReady();

  trayInstance = new Tray(createTrayImage("starting"));
  serviceManagerInstance = new ServiceManager(
    getAppRoot(),
    runtimeRoot,
    logger,
    DEFAULT_PORT,
    launchContext,
  );
  serviceManagerInstance.attachTray(trayInstance);

  await serviceManagerInstance.initialize();
}

bootstrap().catch((error) => {
  const fallbackRunDir = getRunDir(getRuntimeRoot());
  mkdirSync(fallbackRunDir, { recursive: true });
  appendFileSync(
    path.join(fallbackRunDir, "tray.log"),
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "tray.bootstrap_failed",
      ctx: {
        error: error instanceof Error ? error.message : String(error),
      },
    })}\n`,
    "utf-8",
  );
  app.quit();
});
