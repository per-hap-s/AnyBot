import { EnvHttpProxyAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { readProxyConfig, getProxyUrl, type ProxyConfig } from "./web/proxy-config.js";
import { logger } from "./logger.js";

// Dot-prefixed for correct subdomain matching in both undici and proxy-from-env (used by axios).
// e.g. ".feishu.cn" matches "open.feishu.cn", "bytedance.feishu.cn", etc.
const BYPASS_DOMAINS = [
  ".feishu.cn",
  ".larksuite.com",
  ".qq.com",
  "localhost",
  "127.0.0.1",
  "::1",
];

let currentProxyUrl: string | null = null;
let originalDispatcher: Dispatcher | null = null;
let currentProxyMode: "config" | "env" | "none" = "none";

type ProxyEnvSnapshot = {
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  ALL_PROXY?: string;
  NO_PROXY?: string;
  http_proxy?: string;
  https_proxy?: string;
  all_proxy?: string;
  no_proxy?: string;
};

function captureProxyEnv(env: NodeJS.ProcessEnv = process.env): ProxyEnvSnapshot {
  return {
    HTTP_PROXY: env.HTTP_PROXY,
    HTTPS_PROXY: env.HTTPS_PROXY,
    ALL_PROXY: env.ALL_PROXY,
    NO_PROXY: env.NO_PROXY,
    http_proxy: env.http_proxy,
    https_proxy: env.https_proxy,
    all_proxy: env.all_proxy,
    no_proxy: env.no_proxy,
  };
}

function getProxyEnvUrl(snapshot: ProxyEnvSnapshot): string | null {
  return snapshot.HTTPS_PROXY
    || snapshot.https_proxy
    || snapshot.HTTP_PROXY
    || snapshot.http_proxy
    || snapshot.ALL_PROXY
    || snapshot.all_proxy
    || null;
}

function hasProxyEnv(snapshot: ProxyEnvSnapshot): boolean {
  return Boolean(getProxyEnvUrl(snapshot));
}

function getNoProxyValue(snapshot: ProxyEnvSnapshot): string | undefined {
  return snapshot.NO_PROXY || snapshot.no_proxy;
}

function restoreProxyEnv(snapshot: ProxyEnvSnapshot): void {
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ] as const) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createProxyDispatcherFromEnv(snapshot: ProxyEnvSnapshot): Dispatcher | null {
  const proxyUrl = getProxyEnvUrl(snapshot);
  if (!proxyUrl) {
    return null;
  }

  return new EnvHttpProxyAgent({
    httpProxy: snapshot.HTTP_PROXY || snapshot.http_proxy || proxyUrl,
    httpsProxy: snapshot.HTTPS_PROXY || snapshot.https_proxy || proxyUrl,
    noProxy: getNoProxyValue(snapshot),
  });
}

const inheritedProxyEnv = captureProxyEnv();
const inheritedProxyDispatcher = createProxyDispatcherFromEnv(inheritedProxyEnv);

export function shouldPreserveExistingEnvProxy(
  config: ProxyConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !config.enabled && hasProxyEnv(captureProxyEnv(env));
}

export function applyProxy(config?: ProxyConfig): void {
  const cfg = config ?? readProxyConfig();
  const proxyUrl = getProxyUrl(cfg);

  if (proxyUrl) {
    if (proxyUrl === currentProxyUrl && currentProxyMode === "config") {
      return;
    }
  } else if (!cfg.enabled && currentProxyMode === "env" && hasProxyEnv(inheritedProxyEnv)) {
    return;
  } else if (!cfg.enabled && currentProxyMode === "none" && !hasProxyEnv(inheritedProxyEnv)) {
    return;
  }

  if (!originalDispatcher) {
    originalDispatcher = getGlobalDispatcher();
  }

  if (!proxyUrl) {
    currentProxyUrl = null;
    if (hasProxyEnv(inheritedProxyEnv) && inheritedProxyDispatcher) {
      restoreProxyEnv(inheritedProxyEnv);
      setGlobalDispatcher(inheritedProxyDispatcher);
      currentProxyMode = "env";
      logger.info("proxy.env_preserved", {
        source: "environment",
        proxyUrl: getProxyEnvUrl(inheritedProxyEnv),
        noProxy: getNoProxyValue(inheritedProxyEnv) || null,
      });
      return;
    }

    if (originalDispatcher) {
      setGlobalDispatcher(originalDispatcher);
      logger.info("proxy.disabled");
    }
    currentProxyMode = "none";
    setProxyEnvVars(null);
    return;
  }

  const noProxy = BYPASS_DOMAINS.join(",");

  try {
    const agent = new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy,
    });
    setGlobalDispatcher(agent);
    currentProxyUrl = proxyUrl;
    currentProxyMode = "config";
    setProxyEnvVars(proxyUrl, noProxy);
    logger.info("proxy.applied", {
      protocol: cfg.protocol,
      host: cfg.host,
      port: cfg.port,
      noProxy,
    });
  } catch (error) {
    logger.error("proxy.apply_failed", { error, proxyUrl });
    throw new Error(`代理配置无效: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function setProxyEnvVars(proxyUrl: string | null, noProxy?: string): void {
  if (proxyUrl) {
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.http_proxy = proxyUrl;
    process.env.https_proxy = proxyUrl;
    const np = noProxy ?? BYPASS_DOMAINS.join(",");
    process.env.NO_PROXY = np;
    process.env.no_proxy = np;
  } else {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  }
}

export function getActiveProxyUrl(): string | null {
  return currentProxyUrl;
}
