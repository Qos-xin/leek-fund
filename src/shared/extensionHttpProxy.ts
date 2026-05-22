import axios, { AxiosRequestConfig } from 'axios';
import { workspace } from 'vscode';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

let httpsProxyAgent: HttpsProxyAgent | undefined;
let httpProxyAgent: HttpProxyAgent | undefined;
let bypassRules: string[] = [];
let installed = false;

function parseBypass(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 规则：精确主机名、*.example.com、.cn（后缀匹配） */
function hostMatchesBypass(hostname: string, rules: string[]): boolean {
  const h = hostname.toLowerCase();
  for (const rule of rules) {
    if (rule.startsWith('*.')) {
      const root = rule.slice(2);
      if (h === root || h.endsWith('.' + root)) {
        return true;
      }
      continue;
    }
    if (rule.startsWith('.')) {
      if (h === rule.slice(1) || h.endsWith(rule)) {
        return true;
      }
      continue;
    }
    if (h === rule) {
      return true;
    }
  }
  return false;
}

function resolveAbsoluteUrl(config: AxiosRequestConfig): string | null {
  const u = config.url || '';
  const base = config.baseURL || '';
  if (!u && !base) {
    return null;
  }
  try {
    if (/^https?:\/\//i.test(u)) {
      return u;
    }
    return new URL(u || '', base || 'http://placeholder.local').href;
  } catch {
    return null;
  }
}

function readProxySettings(): { proxyUrl: string; bypassRaw: string } {
  const cfg = workspace.getConfiguration();
  return {
    proxyUrl: String(cfg.get('leek-fund.extensionHttpProxy', '') ?? '').trim(),
    bypassRaw: String(cfg.get('leek-fund.extensionHttpProxyBypass', '') ?? '').trim(),
  };
}

/** 供命令面板等读取当前值（不用 LeekFundConfig.getConfig，避免非数组配置的默认值歧义） */
export function readExtensionHttpProxyUiState(): { proxyUrl: string; bypassRaw: string } {
  return readProxySettings();
}

export function refreshExtensionHttpProxy(): void {
  const { proxyUrl, bypassRaw } = readProxySettings();
  bypassRules = parseBypass(bypassRaw);
  httpsProxyAgent = undefined;
  httpProxyAgent = undefined;

  if (!proxyUrl) {
    return;
  }
  try {
    httpsProxyAgent = new HttpsProxyAgent(proxyUrl);
    httpProxyAgent = new HttpProxyAgent(proxyUrl);
  } catch (e) {
    console.error('[盘讯] 扩展代理 URL 无效:', e);
  }
}

/**
 * 安装 axios 拦截器：禁用 VS Code / 环境变量带来的代理行为（每请求 proxy: false），
 * 仅当配置 leek-fund.extensionHttpProxy 时使用扩展自有代理。
 * 须在首次发起网络请求前调用一次。
 */
export function installExtensionHttpProxy(): void {
  if (installed) {
    refreshExtensionHttpProxy();
    return;
  }
  installed = true;

  axios.defaults.proxy = false;

  axios.interceptors.request.use((config) => {
    (config as { proxy?: unknown }).proxy = false;

    const href = resolveAbsoluteUrl(config);
    let useProxy = Boolean(httpsProxyAgent && httpProxyAgent && href);
    if (href && useProxy) {
      try {
        const hostname = new URL(href).hostname;
        if (hostMatchesBypass(hostname, bypassRules)) {
          useProxy = false;
        }
      } catch {
        /* ignore */
      }
    }

    if (useProxy && httpsProxyAgent && httpProxyAgent) {
      config.httpsAgent = httpsProxyAgent;
      config.httpAgent = httpProxyAgent;
    } else {
      delete config.httpsAgent;
      delete config.httpAgent;
    }

    return config;
  });

  refreshExtensionHttpProxy();
}

export function getExtensionHttpProxySummary(): string {
  const { proxyUrl, bypassRaw } = readProxySettings();
  if (!proxyUrl) {
    return '扩展代理：关闭（直连，不使用 VS Code http.proxy）';
  }
  return `扩展代理：${proxyUrl}${bypassRaw ? `，绕过：${bypassRaw}` : ''}`;
}
