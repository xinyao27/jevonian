import { describe, expect, it } from "vite-plus/test";

import {
  applySystemProxy,
  formatFetchError,
  isTransientProxyError,
  parseScutilProxy,
  proxyAgentOptions,
  scrubProxyEnv,
  type SystemProxy,
} from "./proxy";

const ENABLED = `<dictionary> {
  ExceptionsList : <array> {
    0 : 119.29.29.29.dns
    1 : *.abchina.com.cn
    2 : 192.168.0.0/16
    3 : *.local
    4 : localhost
  }
  ExcludeSimpleHostnames : 1
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 1082
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 1082
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
  SOCKSProxy : 127.0.0.1
}`;

const HTTP_ONLY = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 10.0.0.2
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://wpad/wpad.dat
}`;

const DISABLED = `<dictionary> {
  ExcludeSimpleHostnames : 0
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}`;

const EMPTY = "<dictionary> {\n}";

describe("parseScutilProxy", () => {
  it("reads the https proxy and carries the exceptions across", () => {
    expect(parseScutilProxy(ENABLED)).toEqual({
      url: "http://127.0.0.1:1082",
      bypass: [
        "localhost",
        "127.0.0.1",
        "::1",
        "119.29.29.29.dns",
        "*.abchina.com.cn",
        "192.168.0.0/16",
        "*.local",
      ],
    });
  });

  it("falls back to the http proxy when only http proxying is on", () => {
    expect(parseScutilProxy(HTTP_ONLY)?.url).toBe("http://10.0.0.2:7890");
  });

  it("reports nothing when no proxy is enabled", () => {
    expect(parseScutilProxy(DISABLED)).toBeUndefined();
    expect(parseScutilProxy(EMPTY)).toBeUndefined();
  });

  it("does not mistake a pac url for a proxy", () => {
    // The pac block is a scalar, not a proxy: a machine on auto-configuration has no
    // host to dial, and guessing one would send traffic to the wrong place.
    expect(parseScutilProxy(HTTP_ONLY)?.url).not.toContain("wpad");
  });
});

describe("applySystemProxy", () => {
  const detected: SystemProxy = { url: "http://127.0.0.1:1082", bypass: ["127.0.0.1", "*.local"] };

  it("writes the proxy in the spellings node reads", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applySystemProxy(env, () => detected)).toEqual(detected);
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:1082");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:1082");
    // Loopback is exempt whether or not the machine listed it, so Jevonian's own
    // provider traffic on 127.0.0.1 never leaves the process.
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1,*.local");
  });

  it("keeps the env's own bypass list and adds to it", () => {
    const env: NodeJS.ProcessEnv = { NO_PROXY: "example.test, ,127.0.0.1" };
    applySystemProxy(env, () => detected);
    expect(env.NO_PROXY).toBe("example.test,127.0.0.1,localhost,::1,*.local");
  });

  it("stands down when the environment already names a proxy", () => {
    const env: NodeJS.ProcessEnv = { HTTPS_PROXY: "http://corp:8080" };
    expect(applySystemProxy(env, () => detected)).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("http://corp:8080");
    expect(env.HTTP_PROXY).toBeUndefined();
  });

  it("stands down when switched off by hand", () => {
    const env: NodeJS.ProcessEnv = { JEVONIAN_SYSTEM_PROXY: "off" };
    expect(applySystemProxy(env, () => detected)).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it("reports nothing when the machine has no proxy", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applySystemProxy(env, () => undefined)).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });
});

describe("proxyAgentOptions", () => {
  it("holds idle sockets far longer than undici's 4s default", () => {
    // The default drops the pooled connection before the next agent turn, so every
    // turn to a proxied host pays a fresh TLS handshake on the critical path.
    const options = proxyAgentOptions();
    expect(options.keepAliveTimeout).toBe(120_000);
    expect(options.keepAliveTimeout).toBeGreaterThan(4_000);
  });

  it("pins egress to HTTP/1.1", () => {
    // HTTP/2 hands Node's built-in fetch a response with no headers and a still
    // compressed body, which is how every quota lookup started failing on undici
    // 8.11.0. The socket-lifetime policy above is also HTTP/1.1-only.
    expect(proxyAgentOptions().allowH2).toBe(false);
  });

  it("keeps the caller's proxy settings alongside it", () => {
    const options = proxyAgentOptions({
      httpProxy: "http://127.0.0.1:1082",
      httpsProxy: "http://127.0.0.1:1082",
      noProxy: "localhost,127.0.0.1",
    });
    expect(options).toEqual({
      httpProxy: "http://127.0.0.1:1082",
      httpsProxy: "http://127.0.0.1:1082",
      noProxy: "localhost,127.0.0.1",
      keepAliveTimeout: 120_000,
      allowH2: false,
    });
  });
});

describe("scrubProxyEnv", () => {
  it("strips every proxy spelling so tunnel children dial direct", () => {
    const scrubbed = scrubProxyEnv({
      HTTPS_PROXY: "http://127.0.0.1:1082",
      http_proxy: "http://127.0.0.1:1082",
      PATH: "/usr/bin",
      NO_PROXY: "localhost",
    });
    expect(scrubbed.HTTPS_PROXY).toBeUndefined();
    expect(scrubbed.http_proxy).toBeUndefined();
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.NO_PROXY).toBe("localhost");
  });
});

describe("isTransientProxyError", () => {
  it("recognises the Clash mid-download abort shape", () => {
    const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const error = Object.assign(new TypeError("terminated"), { cause });
    expect(isTransientProxyError(error)).toBe(true);
    expect(formatFetchError(error)).toContain("terminated");
    expect(formatFetchError(error)).toContain("UND_ERR_SOCKET");
  });

  it("leaves ordinary errors alone", () => {
    expect(isTransientProxyError(new Error("no Jev brain is configured"))).toBe(false);
  });
});
