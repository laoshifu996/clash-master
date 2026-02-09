import type {
  StatsSummary,
  DomainStats,
  IPStats,
  ProxyStats,
  RuleStats,
  CountryStats,
  HourlyStats,
  DailyStats,
  TrafficTrendPoint,
  ProxyTrafficStats,
  DeviceStats,
} from "@clashmaster/shared";

type RuntimeConfig = {
  API_URL?: string;
};

function getRuntimeConfig(): RuntimeConfig | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as any).__RUNTIME_CONFIG__ as RuntimeConfig | undefined;
}

function normalizeApiBase(url: string): string {
  if (!url) return "/api";
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function resolveApiBase(): string {
  const runtime = getRuntimeConfig();
  if (runtime?.API_URL) {
    return normalizeApiBase(runtime.API_URL);
  }
  const envUrl = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL;
  if (envUrl) {
    return normalizeApiBase(envUrl);
  }
  return "/api";
}

const API_BASE = resolveApiBase();
const DETAIL_FETCH_LIMIT = 5000;

async function fetchJson<T>(url: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: any): Promise<T> {
  const options: RequestInit = {
    method,
    headers: {},
  };
  
  // Only set Content-Type when there's a body
  if (body && method !== 'GET') {
    options.headers = {
      'Content-Type': 'application/json',
    };
    options.body = JSON.stringify(body);
  }
  
  console.log(`[API] ${method} ${url}`);
  const res = await fetch(url, options);
  if (!res.ok) {
    console.error(`[API] Error ${res.status}: ${url}`);
    throw new Error(`API error: ${res.status}`);
  }
  return res.json();
}

export interface TimeRange {
  start: string;
  end: string;
}

export interface Backend {
  id: number;
  name: string;
  url: string;
  token: string;
  enabled: boolean;
  is_active: boolean;
  listening: boolean;
  hasToken?: boolean;
  created_at: string;
  updated_at: string;
}

export interface ClashProviderProxy {
  alive: boolean;
  name: string;
  type: string;
  now?: string;
  all?: string[];
  history?: Array<{ time: string; delay: number }>;
}

export interface ClashProvider {
  name: string;
  type: string;
  vehicleType: string;
  proxies: ClashProviderProxy[];
}

export interface ClashProvidersResponse {
  providers: Record<string, ClashProvider>;
}

export interface ClashRule {
  type: string;
  payload: string;
  proxy: string;
}

export interface ClashRulesResponse {
  rules: ClashRule[];
}

function buildUrl(base: string, params: Record<string, string | number | undefined>): string {
  // Use simple URL construction for client-side relative URLs
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return query ? `${base}?${query}` : base;
}

export const api = {
  // Stats APIs with optional backendId parameter
  getSummary: (backendId?: number, range?: TimeRange) => 
    fetchJson<StatsSummary & { backend: { id: number; name: string; isActive: boolean; listening: boolean } }>(
      buildUrl(`${API_BASE}/stats/summary`, {
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),
  
  getGlobalSummary: () =>
    fetchJson<{
      totalConnections: number;
      totalUpload: number;
      totalDownload: number;
      uniqueDomains: number;
      uniqueIPs: number;
      backendCount: number;
    }>(`${API_BASE}/stats/global`),
    
  getDomains: (backendId?: number, opts?: {
    offset?: number; limit?: number;
    sortBy?: string; sortOrder?: string; search?: string;
    start?: string; end?: string;
  }) =>
    fetchJson<{ data: DomainStats[]; total: number }>(
      buildUrl(`${API_BASE}/stats/domains`, { backendId, ...opts })
    ),

  getIPs: (backendId?: number, opts?: {
    offset?: number; limit?: number;
    sortBy?: string; sortOrder?: string; search?: string;
    start?: string; end?: string;
  }) =>
    fetchJson<{ data: IPStats[]; total: number }>(
      buildUrl(`${API_BASE}/stats/ips`, { backendId, ...opts })
    ),
    
  getProxies: (backendId?: number, limit = 50, range?: TimeRange) =>
    fetchJson<ProxyStats[]>(buildUrl(`${API_BASE}/stats/proxies`, {
      backendId,
      limit,
      start: range?.start,
      end: range?.end,
    })),
    
  getRules: (backendId?: number, limit = 50, range?: TimeRange) =>
    fetchJson<RuleStats[]>(buildUrl(`${API_BASE}/stats/rules`, {
      backendId,
      limit,
      start: range?.start,
      end: range?.end,
    })),
    
  getCountries: (backendId?: number, limit = 50, range?: TimeRange) =>
    fetchJson<CountryStats[]>(buildUrl(`${API_BASE}/stats/countries`, {
      backendId,
      limit,
      start: range?.start,
      end: range?.end,
    })),
    
  getRuleProxies: (backendId?: number) =>
    fetchJson<{ rule: string; proxies: string[] }[]>(
      buildUrl(`${API_BASE}/stats/rule-proxy-map`, { backendId })
    ),
    
  getHourly: (backendId?: number, hours = 24, range?: TimeRange) =>
    fetchJson<HourlyStats[]>(buildUrl(`${API_BASE}/stats/hourly`, {
      backendId,
      hours,
      start: range?.start,
      end: range?.end,
    })),
    
  getDaily: (backendId?: number, days = 7) =>
    fetchJson<DailyStats[]>(buildUrl(`${API_BASE}/stats/daily`, { backendId, days })),
    
  getTrafficTrend: (backendId?: number, minutes = 30, range?: TimeRange) =>
    fetchJson<TrafficTrendPoint[]>(buildUrl(`${API_BASE}/stats/trend`, {
      backendId,
      minutes,
      start: range?.start,
      end: range?.end,
    })),

  getTrafficTrendAggregated: (backendId?: number, minutes = 30, bucketMinutes = 1, range?: TimeRange) =>
    fetchJson<TrafficTrendPoint[]>(
      buildUrl(`${API_BASE}/stats/trend/aggregated`, {
        backendId,
        minutes,
        bucketMinutes,
        start: range?.start,
        end: range?.end,
      })
    ),
    
  getConnections: (backendId?: number, limit = 100) =>
    fetchJson<Array<{ id: number; domain: string; ip: string; chain: string; upload: number; download: number; timestamp: string }>>(
      buildUrl(`${API_BASE}/stats/connections`, { backendId, limit })
    ),
    
  getDomainProxyStats: (
    domain: string,
    backendId?: number,
    range?: TimeRange,
    sourceIP?: string,
    sourceChain?: string,
  ) =>
    fetchJson<ProxyTrafficStats[]>(
      buildUrl(`${API_BASE}/stats/domains/proxy-stats`, {
        domain,
        backendId,
        start: range?.start,
        end: range?.end,
        sourceIP,
        sourceChain,
      })
    ),

  getDomainIPDetails: (
    domain: string,
    backendId?: number,
    range?: TimeRange,
    sourceIP?: string,
    sourceChain?: string,
  ) =>
    fetchJson<IPStats[]>(
      buildUrl(`${API_BASE}/stats/domains/ip-details`, {
        domain,
        backendId,
        start: range?.start,
        end: range?.end,
        sourceIP,
        sourceChain,
      })
    ),

  getIPProxyStats: (
    ip: string,
    backendId?: number,
    range?: TimeRange,
    sourceIP?: string,
    sourceChain?: string,
  ) =>
    fetchJson<ProxyTrafficStats[]>(
      buildUrl(`${API_BASE}/stats/ips/proxy-stats`, {
        ip,
        backendId,
        start: range?.start,
        end: range?.end,
        sourceIP,
        sourceChain,
      })
    ),

  getIPDomainDetails: (
    ip: string,
    backendId?: number,
    range?: TimeRange,
    sourceIP?: string,
    limit = DETAIL_FETCH_LIMIT,
    sourceChain?: string,
  ) =>
    fetchJson<DomainStats[]>(
      buildUrl(`${API_BASE}/stats/ips/domain-details`, {
        ip,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
        sourceIP,
        sourceChain,
      })
    ),

  getProxyDomains: (chain: string, backendId?: number, range?: TimeRange, limit = DETAIL_FETCH_LIMIT) =>
    fetchJson<DomainStats[]>(
      buildUrl(`${API_BASE}/stats/proxies/domains`, {
        chain,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getProxyIPs: (chain: string, backendId?: number, range?: TimeRange, limit = DETAIL_FETCH_LIMIT) =>
    fetchJson<IPStats[]>(
      buildUrl(`${API_BASE}/stats/proxies/ips`, {
        chain,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  // Device stats APIs
  getDevices: (backendId?: number, limit = 50, range?: TimeRange) =>
    fetchJson<DeviceStats[]>(
      buildUrl(`${API_BASE}/stats/devices`, { backendId, limit, start: range?.start, end: range?.end })
    ),

  getDeviceDomains: (sourceIP: string, backendId?: number, range?: TimeRange, limit = DETAIL_FETCH_LIMIT) =>
    fetchJson<DomainStats[]>(
      buildUrl(`${API_BASE}/stats/devices/domains`, {
        sourceIP,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getDeviceIPs: (sourceIP: string, backendId?: number, range?: TimeRange, limit = DETAIL_FETCH_LIMIT) =>
    fetchJson<IPStats[]>(
      buildUrl(`${API_BASE}/stats/devices/ips`, {
        sourceIP,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getRuleDomains: (rule: string, backendId?: number, range?: TimeRange, limit = DETAIL_FETCH_LIMIT) =>
    fetchJson<DomainStats[]>(
      buildUrl(`${API_BASE}/stats/rules/domains`, {
        rule,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getRuleIPs: (rule: string, backendId?: number, range?: TimeRange, limit = DETAIL_FETCH_LIMIT) =>
    fetchJson<IPStats[]>(
      buildUrl(`${API_BASE}/stats/rules/ips`, {
        rule,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getRuleDomainProxyStats: (
    rule: string,
    domain: string,
    backendId?: number,
    range?: TimeRange,
  ) =>
    fetchJson<ProxyTrafficStats[]>(
      buildUrl(`${API_BASE}/stats/rules/domains/proxy-stats`, {
        rule,
        domain,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getRuleDomainIPDetails: (
    rule: string,
    domain: string,
    backendId?: number,
    range?: TimeRange,
    limit = DETAIL_FETCH_LIMIT,
  ) =>
    fetchJson<IPStats[]>(
      buildUrl(`${API_BASE}/stats/rules/domains/ip-details`, {
        rule,
        domain,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getRuleIPProxyStats: (
    rule: string,
    ip: string,
    backendId?: number,
    range?: TimeRange,
  ) =>
    fetchJson<ProxyTrafficStats[]>(
      buildUrl(`${API_BASE}/stats/rules/ips/proxy-stats`, {
        rule,
        ip,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getRuleIPDomainDetails: (
    rule: string,
    ip: string,
    backendId?: number,
    range?: TimeRange,
    limit = DETAIL_FETCH_LIMIT,
  ) =>
    fetchJson<DomainStats[]>(
      buildUrl(`${API_BASE}/stats/rules/ips/domain-details`, {
        rule,
        ip,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getRuleChainFlow: (rule: string, backendId?: number, range?: TimeRange) =>
    fetchJson<{ nodes: Array<{ name: string; totalUpload: number; totalDownload: number; totalConnections: number }>; links: Array<{ source: number; target: number }> }>(
      buildUrl(`${API_BASE}/stats/rules/chain-flow`, {
        rule,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getAllRuleChainFlows: (backendId?: number, range?: TimeRange) =>
    fetchJson<{
      nodes: Array<{ name: string; layer: number; nodeType: 'rule' | 'group' | 'proxy'; totalUpload: number; totalDownload: number; totalConnections: number; rules: string[] }>;
      links: Array<{ source: number; target: number; rules: string[] }>;
      rulePaths: Record<string, { nodeIndices: number[]; linkIndices: number[] }>;
      maxLayer: number;
    }>(
      buildUrl(`${API_BASE}/stats/rules/chain-flow-all`, {
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getClashProviders: (backendId?: number) =>
    fetchJson<ClashProvidersResponse>(buildUrl(`${API_BASE}/clash/providers/proxies`, { backendId })),

  getClashRules: (backendId?: number) =>
    fetchJson<ClashRulesResponse>(buildUrl(`${API_BASE}/clash/rules`, { backendId })),

  search: (q: string) =>
    fetchJson<DomainStats[]>(
      `${API_BASE}/search?q=${encodeURIComponent(q)}`
    ),
    
  // Backend management
  getBackends: () =>
    fetchJson<Backend[]>(`${API_BASE}/backends`),
    
  getActiveBackend: () =>
    fetchJson<Backend | { error: string }>(`${API_BASE}/backends/active`),

  getListeningBackends: () =>
    fetchJson<Backend[]>(`${API_BASE}/backends/listening`),
    
  createBackend: (backend: { name: string; url: string; token?: string }) =>
    fetchJson<{ id: number; isActive?: boolean; message: string }>(`${API_BASE}/backends`, 'POST', backend),
    
  updateBackend: (id: number, backend: { name?: string; url?: string; token?: string; enabled?: boolean; listening?: boolean }) =>
    fetchJson<{ message: string }>(`${API_BASE}/backends/${id}`, 'PUT', backend),
    
  deleteBackend: (id: number) =>
    fetchJson<{ message: string }>(`${API_BASE}/backends/${id}`, 'DELETE'),
    
  setActiveBackend: (id: number) =>
    fetchJson<{ message: string }>(`${API_BASE}/backends/${id}/activate`, 'POST'),

  setBackendListening: (id: number, listening: boolean) =>
    fetchJson<{ message: string }>(`${API_BASE}/backends/${id}/listening`, 'POST', { listening }),

  clearBackendData: (id: number) =>
    fetchJson<{ message: string }>(`${API_BASE}/backends/${id}/clear-data`, 'POST'),
    
  testBackend: (url: string, token?: string) =>
    fetchJson<{ success: boolean; message: string }>(`${API_BASE}/backends/test`, 'POST', { url, token }),

  testBackendById: (id: number) =>
    fetchJson<{ success: boolean; message: string }>(`${API_BASE}/backends/${id}/test`, 'POST'),
    
  // Database management
  getDbStats: () =>
    fetchJson<{ size: number; totalConnectionsCount: number }>(`${API_BASE}/db/stats`),
    
  clearLogs: (days: number, backendId?: number) =>
    fetchJson<{ message: string; deleted: number }>(`${API_BASE}/db/cleanup`, 'POST', { days, backendId }),

  vacuumDatabase: () =>
    fetchJson<{ message: string }>(`${API_BASE}/db/vacuum`, 'POST'),

  getRetentionConfig: () =>
    fetchJson<{ connectionLogsDays: number; hourlyStatsDays: number; autoCleanup: boolean }>(`${API_BASE}/db/retention`),

  updateRetentionConfig: (config: { connectionLogsDays: number; hourlyStatsDays: number; autoCleanup?: boolean }) =>
    fetchJson<{ message: string }>(`${API_BASE}/db/retention`, 'PUT', config),
};

// Helper functions for time range
export function getPresetTimeRange(
  preset: "1m" | "5m" | "15m" | "30m" | "7d" | "30d" | "24h" | "today",
): TimeRange {
  const end = new Date();
  const start = new Date();
  
  switch (preset) {
    case "1m":
      start.setMinutes(start.getMinutes() - 1);
      break;
    case "5m":
      start.setMinutes(start.getMinutes() - 5);
      break;
    case "15m":
      start.setMinutes(start.getMinutes() - 15);
      break;
    case "30m":
      start.setMinutes(start.getMinutes() - 30);
      break;
    case '7d':
      start.setDate(start.getDate() - 7);
      break;
    case '30d':
      start.setDate(start.getDate() - 30);
      break;
    case '24h':
      start.setHours(start.getHours() - 24);
      break;
    case 'today':
      start.setHours(0, 0, 0, 0);
      break;
  }
  
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

export function formatDateTimeForInput(date: Date): string {
  return date.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
}

export function formatDateTimeDisplay(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
