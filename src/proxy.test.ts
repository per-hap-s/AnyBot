import test from "node:test";
import assert from "node:assert/strict";

import { shouldPreserveExistingEnvProxy } from "./proxy.js";
import type { ProxyConfig } from "./web/proxy-config.js";

const disabledProxyConfig: ProxyConfig = {
  enabled: false,
  protocol: "http",
  host: "127.0.0.1",
  port: 7890,
};

test("proxy bootstrap preserves inherited HTTP proxy when file proxy is disabled", () => {
  assert.equal(
    shouldPreserveExistingEnvProxy(disabledProxyConfig, {
      HTTP_PROXY: "http://127.0.0.1:10809",
    }),
    true,
  );
});

test("proxy bootstrap preserves inherited lowercase proxy when file proxy is disabled", () => {
  assert.equal(
    shouldPreserveExistingEnvProxy(disabledProxyConfig, {
      https_proxy: "http://127.0.0.1:10809",
    }),
    true,
  );
});

test("proxy bootstrap does not preserve environment proxy when file proxy is enabled", () => {
  assert.equal(
    shouldPreserveExistingEnvProxy({
      ...disabledProxyConfig,
      enabled: true,
    }, {
      HTTP_PROXY: "http://127.0.0.1:10809",
    }),
    false,
  );
});

test("proxy bootstrap does not preserve environment proxy when no env proxy exists", () => {
  assert.equal(shouldPreserveExistingEnvProxy(disabledProxyConfig, {}), false);
});
