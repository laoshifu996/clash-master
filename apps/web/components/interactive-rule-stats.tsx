"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { Server, ChevronLeft, ChevronRight, Loader2, BarChart3, Link2, Rows3, ArrowUpDown, ArrowDown, ArrowUp, Globe, Waypoints, ChevronDown, ChevronUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell as BarCell, LabelList } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatBytes, formatNumber } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { api, type ClashRulesResponse, type TimeRange } from "@/lib/api";
import { CountryFlag } from "@/components/country-flag";
import { Favicon } from "@/components/favicon";
import { ProxyChainBadge } from "@/components/proxy-chain-badge";
import { DomainExpandedDetails, IPExpandedDetails } from "@/components/stats-tables/expanded-details";
import { UnifiedRuleChainFlow } from "@/components/rule-chain-flow";
import type { RuleStats, DomainStats, IPStats, ProxyTrafficStats } from "@clashmaster/shared";

interface InteractiveRuleStatsProps {
  data: RuleStats[];
  activeBackendId?: number;
  timeRange?: TimeRange;
  backendStatus?: "healthy" | "unhealthy" | "unknown";
}

const COLORS = [
  "#3B82F6", "#8B5CF6", "#06B6D4", "#10B981", "#F59E0B",
  "#EF4444", "#EC4899", "#6366F1", "#14B8A6", "#F97316",
];

const CHART_COLORS = [
  "#3B82F6", "#8B5CF6", "#06B6D4", "#10B981", "#F59E0B",
  "#EF4444", "#EC4899", "#6366F1", "#14B8A6", "#F97316",
];

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];

// Domain sort keys
type DomainSortKey = "domain" | "totalDownload" | "totalUpload" | "totalConnections";
type SortOrder = "asc" | "desc";

// IP sort keys
type IPSortKey = "ip" | "totalDownload" | "totalUpload" | "totalConnections";

// Color palette for icons
const ICON_COLORS = [
  { bg: "bg-blue-500", text: "text-white" },
  { bg: "bg-violet-500", text: "text-white" },
  { bg: "bg-emerald-500", text: "text-white" },
  { bg: "bg-amber-500", text: "text-white" },
  { bg: "bg-rose-500", text: "text-white" },
  { bg: "bg-cyan-500", text: "text-white" },
  { bg: "bg-indigo-500", text: "text-white" },
  { bg: "bg-teal-500", text: "text-white" },
];

const getIPColor = (ip: string) => {
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    hash = ip.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ICON_COLORS[Math.abs(hash) % ICON_COLORS.length];
};

// Custom label renderer for bar chart
function renderCustomBarLabel(props: any) {
  const { x, y, width, value, height } = props;
  return (
    <text
      x={x + width + 6}
      y={y + height / 2}
      fill="currentColor"
      fontSize={11}
      dominantBaseline="central"
      textAnchor="start"
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      {formatBytes(value, 0)}
    </text>
  );
}

export function InteractiveRuleStats({
  data,
  activeBackendId,
  timeRange,
  backendStatus,
}: InteractiveRuleStatsProps) {
  const t = useTranslations("rules");
  const domainsT = useTranslations("domains");
  const ipsT = useTranslations("ips");
  const backendT = useTranslations("dashboard");
  
  const [selectedRule, setSelectedRule] = useState<string | null>(null);
  const [ruleDomains, setRuleDomains] = useState<DomainStats[]>([]);
  const [ruleIPs, setRuleIPs] = useState<IPStats[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("domains");
  
  // Pagination states
  const [domainPage, setDomainPage] = useState(1);
  const [domainPageSize, setDomainPageSize] = useState<PageSize>(10);
  const [domainSearch, setDomainSearch] = useState("");
  const [ipPage, setIpPage] = useState(1);
  const [ipPageSize, setIpPageSize] = useState<PageSize>(10);
  const [ipSearch, setIpSearch] = useState("");
  const [showDomainBarLabels, setShowDomainBarLabels] = useState(true);
  const [clashRules, setClashRules] = useState<ClashRulesResponse | null>(null);

  // Sort states
  const [domainSortKey, setDomainSortKey] = useState<DomainSortKey>("totalDownload");
  const [domainSortOrder, setDomainSortOrder] = useState<SortOrder>("desc");
  const [ipSortKey, setIpSortKey] = useState<IPSortKey>("totalDownload");
  const [ipSortOrder, setIpSortOrder] = useState<SortOrder>("desc");

  // Expanded states
  const [expandedDomain, setExpandedDomain] = useState<string | null>(null);
  const [expandedIP, setExpandedIP] = useState<string | null>(null);
  const [domainProxyStats, setDomainProxyStats] = useState<Record<string, ProxyTrafficStats[]>>({});
  const [domainProxyStatsLoading, setDomainProxyStatsLoading] = useState<string | null>(null);
  const [domainIPDetails, setDomainIPDetails] = useState<Record<string, IPStats[]>>({});
  const [domainIPDetailsLoading, setDomainIPDetailsLoading] = useState<string | null>(null);
  const [ipProxyStats, setIPProxyStats] = useState<Record<string, ProxyTrafficStats[]>>({});
  const [ipProxyStatsLoading, setIPProxyStatsLoading] = useState<string | null>(null);
  const [ipDomainDetails, setIPDomainDetails] = useState<Record<string, DomainStats[]>>({});
  const [ipDomainDetailsLoading, setIPDomainDetailsLoading] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const prevSelectedRuleRef = useRef<string | null>(null);
  const prevBackendRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 640px)");
    const update = () => setShowDomainBarLabels(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // Fetch Clash rules to find zero-traffic rules
  useEffect(() => {
    let cancelled = false;
    async function fetchClashRules() {
      try {
        const result = await api.getClashRules(activeBackendId);
        if (!cancelled) setClashRules(result);
      } catch {
        // Silent - Clash API may not be available
      }
    }
    fetchClashRules();
    const interval = setInterval(fetchClashRules, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [activeBackendId]);

  const chartData = useMemo(() => {
    if (!data) return [];
    const existingRuleNames = new Set(data.map(r => r.rule));
    const trafficItems = data.map((rule, index) => ({
      name: rule.rule,
      rawName: rule.rule,
      value: rule.totalDownload + rule.totalUpload,
      download: rule.totalDownload,
      upload: rule.totalUpload,
      connections: rule.totalConnections,
      finalProxy: rule.finalProxy,
      color: COLORS[index % COLORS.length],
      rank: index,
      hasTraffic: true,
    }));

    // Append zero-traffic rules from Clash API, using the target proxy group name
    // (rule.proxy) which matches how traffic data stores rule names.
    // Multiple low-level rules (RuleSet, ProcessName, etc.) can target the same
    // proxy group, so we deduplicate by proxy group name.
    if (clashRules?.rules) {
      const zeroTrafficItems: typeof trafficItems = [];
      for (const rule of clashRules.rules) {
        const proxyGroup = rule.proxy;
        if (existingRuleNames.has(proxyGroup)) continue;
        existingRuleNames.add(proxyGroup);
        zeroTrafficItems.push({
          name: proxyGroup,
          rawName: proxyGroup,
          value: 0,
          download: 0,
          upload: 0,
          connections: 0,
          finalProxy: proxyGroup,
          color: "#9CA3AF",
          rank: trafficItems.length + zeroTrafficItems.length,
          hasTraffic: false,
        });
      }
      return [...trafficItems, ...zeroTrafficItems];
    }

    return trafficItems;
  }, [data, clashRules]);

  const totalTraffic = useMemo(() => {
    return chartData.reduce((sum, item) => sum + item.value, 0);
  }, [chartData]);

  const topRules = useMemo(
    () => [...chartData].sort((a, b) => b.value - a.value).slice(0, 4),
    [chartData]
  );

  const maxTotal = useMemo(() => {
    if (!chartData.length) return 1;
    return Math.max(...chartData.map(r => r.value));
  }, [chartData]);

  // Domain sort handler
  const handleDomainSort = (key: DomainSortKey) => {
    if (domainSortKey === key) {
      setDomainSortOrder(domainSortOrder === "asc" ? "desc" : "asc");
    } else {
      setDomainSortKey(key);
      setDomainSortOrder("desc");
    }
    setDomainPage(1);
  };

  // IP sort handler
  const handleIPSort = (key: IPSortKey) => {
    if (ipSortKey === key) {
      setIpSortOrder(ipSortOrder === "asc" ? "desc" : "asc");
    } else {
      setIpSortKey(key);
      setIpSortOrder("desc");
    }
    setIpPage(1);
  };

  // Toggle expand handlers
  const toggleExpandDomain = (domain: string) => {
    const newExpanded = expandedDomain === domain ? null : domain;
    setExpandedDomain(newExpanded);
    if (newExpanded) {
      fetchExpandedDomainDetails(newExpanded);
    }
  };

  const toggleExpandIP = (ip: string) => {
    const newExpanded = expandedIP === ip ? null : ip;
    setExpandedIP(newExpanded);
    if (newExpanded) {
      fetchExpandedIPDetails(newExpanded);
    }
  };

  const fetchExpandedDomainDetails = useCallback(async (
    domain: string,
    options?: { force?: boolean; background?: boolean },
  ) => {
    if (!selectedRule) return;
    const force = options?.force ?? false;
    const background = options?.background ?? false;
    const hasProxyCached = !!domainProxyStats[domain];
    const hasIPCached = !!domainIPDetails[domain];
    if (!force && hasProxyCached && hasIPCached) return;

    if (!background || !hasProxyCached) setDomainProxyStatsLoading(domain);
    if (!background || !hasIPCached) setDomainIPDetailsLoading(domain);
    try {
      const [proxyStats, ipDetails] = await Promise.all([
        api.getRuleDomainProxyStats(selectedRule, domain, activeBackendId, timeRange),
        api.getRuleDomainIPDetails(selectedRule, domain, activeBackendId, timeRange),
      ]);
      setDomainProxyStats((prev) => ({ ...prev, [domain]: proxyStats }));
      setDomainIPDetails((prev) => ({ ...prev, [domain]: ipDetails }));
    } catch (err) {
      console.error(`Failed to fetch rule-domain details for ${domain}:`, err);
      setDomainProxyStats((prev) => ({ ...prev, [domain]: [] }));
      setDomainIPDetails((prev) => ({ ...prev, [domain]: [] }));
    } finally {
      if (domainProxyStatsLoading === domain) setDomainProxyStatsLoading(null);
      if (domainIPDetailsLoading === domain) setDomainIPDetailsLoading(null);
    }
  }, [
    selectedRule,
    domainProxyStats,
    domainIPDetails,
    activeBackendId,
    timeRange,
    domainProxyStatsLoading,
    domainIPDetailsLoading,
  ]);

  const fetchExpandedIPDetails = useCallback(async (
    ip: string,
    options?: { force?: boolean; background?: boolean },
  ) => {
    if (!selectedRule) return;
    const force = options?.force ?? false;
    const background = options?.background ?? false;
    const hasProxyCached = !!ipProxyStats[ip];
    const hasDomainCached = !!ipDomainDetails[ip];
    if (!force && hasProxyCached && hasDomainCached) return;

    if (!background || !hasProxyCached) setIPProxyStatsLoading(ip);
    if (!background || !hasDomainCached) setIPDomainDetailsLoading(ip);
    try {
      const [proxyStats, domainDetails] = await Promise.all([
        api.getRuleIPProxyStats(selectedRule, ip, activeBackendId, timeRange),
        api.getRuleIPDomainDetails(selectedRule, ip, activeBackendId, timeRange),
      ]);
      setIPProxyStats((prev) => ({ ...prev, [ip]: proxyStats }));
      setIPDomainDetails((prev) => ({ ...prev, [ip]: domainDetails }));
    } catch (err) {
      console.error(`Failed to fetch rule-ip details for ${ip}:`, err);
      setIPProxyStats((prev) => ({ ...prev, [ip]: [] }));
      setIPDomainDetails((prev) => ({ ...prev, [ip]: [] }));
    } finally {
      if (ipProxyStatsLoading === ip) setIPProxyStatsLoading(null);
      if (ipDomainDetailsLoading === ip) setIPDomainDetailsLoading(null);
    }
  }, [
    selectedRule,
    ipProxyStats,
    ipDomainDetails,
    activeBackendId,
    timeRange,
    ipProxyStatsLoading,
    ipDomainDetailsLoading,
  ]);

  // Sort icon component
  const DomainSortIcon = ({ column }: { column: DomainSortKey }) => {
    if (domainSortKey !== column) return <ArrowUpDown className="ml-1 h-3 w-3 text-muted-foreground" />;
    return domainSortOrder === "asc" ? (
      <ArrowUp className="ml-1 h-3 w-3 text-primary" />
    ) : (
      <ArrowDown className="ml-1 h-3 w-3 text-primary" />
    );
  };

  const IPSortIcon = ({ column }: { column: IPSortKey }) => {
    if (ipSortKey !== column) return <ArrowUpDown className="ml-1 h-3 w-3 text-muted-foreground" />;
    return ipSortOrder === "asc" ? (
      <ArrowUp className="ml-1 h-3 w-3 text-primary" />
    ) : (
      <ArrowDown className="ml-1 h-3 w-3 text-primary" />
    );
  };

  // Load rule details
  const loadRuleDetails = useCallback(async (
    rule: string,
    options?: { background?: boolean; preserveUiState?: boolean },
  ) => {
    const background = options?.background ?? false;
    const preserveUiState = options?.preserveUiState ?? false;
    const requestId = ++requestIdRef.current;

    if (!background) {
      setLoading(true);
    }

    try {
      const [domains, ips] = await Promise.all([
        api.getRuleDomains(rule, activeBackendId, timeRange),
        api.getRuleIPs(rule, activeBackendId, timeRange),
      ]);
      if (requestId !== requestIdRef.current) return;
      setRuleDomains(domains);
      setRuleIPs(ips);
      if (!preserveUiState) {
        setDomainPage(1);
        setIpPage(1);
        setDomainSearch("");
        setIpSearch("");
      }
    } catch (err) {
      console.error(`Failed to load details for ${rule}:`, err);
      if (!background) {
        setRuleDomains([]);
        setRuleIPs([]);
      }
    } finally {
      if (!background && requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [activeBackendId, timeRange]);

  // Default select first rule when data loads
  useEffect(() => {
    if (chartData.length === 0) {
      setSelectedRule(null);
      setRuleDomains([]);
      setRuleIPs([]);
      return;
    }
    const exists = !!selectedRule && chartData.some((item) => item.rawName === selectedRule);
    if (!exists) {
      setSelectedRule(chartData[0].rawName);
    }
  }, [chartData, selectedRule]);

  useEffect(() => {
    if (selectedRule) {
      const selectedChanged = prevSelectedRuleRef.current !== selectedRule;
      const backendChanged = prevBackendRef.current !== activeBackendId;
      const hasExistingDetails = ruleDomains.length > 0 || ruleIPs.length > 0;
      if (loading && !selectedChanged && !backendChanged) return;
      const background = !selectedChanged && !backendChanged && hasExistingDetails;

      prevSelectedRuleRef.current = selectedRule;
      prevBackendRef.current = activeBackendId;
      loadRuleDetails(selectedRule, {
        background,
        preserveUiState: background,
      });
    }
  }, [selectedRule, activeBackendId, timeRange, loadRuleDetails, ruleDomains.length, ruleIPs.length, loading]);

  useEffect(() => {
    setExpandedDomain(null);
    setExpandedIP(null);
    setDomainProxyStats({});
    setDomainIPDetails({});
    setIPProxyStats({});
    setIPDomainDetails({});
    setDomainProxyStatsLoading(null);
    setDomainIPDetailsLoading(null);
    setIPProxyStatsLoading(null);
    setIPDomainDetailsLoading(null);
  }, [selectedRule, activeBackendId]);

  useEffect(() => {
    if (expandedDomain) {
      fetchExpandedDomainDetails(expandedDomain, { force: true, background: true });
    }
    if (expandedIP) {
      fetchExpandedIPDetails(expandedIP, { force: true, background: true });
    }
  }, [
    timeRange?.start,
    timeRange?.end,
    expandedDomain,
    expandedIP,
    fetchExpandedDomainDetails,
    fetchExpandedIPDetails,
  ]);

  const handleRuleClick = useCallback((rule: string) => {
    if (selectedRule !== rule) {
      setSelectedRule(rule);
    }
  }, [selectedRule]);

  const selectedRuleData = useMemo(() => {
    return chartData.find(r => r.rawName === selectedRule);
  }, [chartData, selectedRule]);

  // Filter, sort and paginate domains
  const filteredDomains = useMemo(() => {
    let result = ruleDomains;
    if (domainSearch) {
      result = ruleDomains.filter(d => 
        d.domain.toLowerCase().includes(domainSearch.toLowerCase())
      );
    }
    // Sort
    return [...result].sort((a, b) => {
      const aValue = a[domainSortKey];
      const bValue = b[domainSortKey];
      const modifier = domainSortOrder === "asc" ? 1 : -1;
      if (typeof aValue === "string" && typeof bValue === "string") {
        return aValue.localeCompare(bValue) * modifier;
      }
      return ((aValue as number) - (bValue as number)) * modifier;
    });
  }, [ruleDomains, domainSearch, domainSortKey, domainSortOrder]);

  const paginatedDomains = useMemo(() => {
    const start = (domainPage - 1) * domainPageSize;
    return filteredDomains.slice(start, start + domainPageSize);
  }, [filteredDomains, domainPage, domainPageSize]);

  const domainTotalPages = Math.ceil(filteredDomains.length / domainPageSize);

  // Filter, sort and paginate IPs
  const filteredIPs = useMemo(() => {
    let result = ruleIPs;
    if (ipSearch) {
      result = ruleIPs.filter(ip => 
        ip.ip.toLowerCase().includes(ipSearch.toLowerCase()) ||
        ip.domains.some(d => d.toLowerCase().includes(ipSearch.toLowerCase()))
      );
    }
    // Sort
    return [...result].sort((a, b) => {
      const aValue = a[ipSortKey];
      const bValue = b[ipSortKey];
      const modifier = ipSortOrder === "asc" ? 1 : -1;
      if (typeof aValue === "string" && typeof bValue === "string") {
        return aValue.localeCompare(bValue) * modifier;
      }
      return ((aValue as number) - (bValue as number)) * modifier;
    });
  }, [ruleIPs, ipSearch, ipSortKey, ipSortOrder]);

  const paginatedIPs = useMemo(() => {
    const start = (ipPage - 1) * ipPageSize;
    return filteredIPs.slice(start, start + ipPageSize);
  }, [filteredIPs, ipPage, ipPageSize]);

  const ipTotalPages = Math.ceil(filteredIPs.length / ipPageSize);

  // Chart data
  const domainChartData = useMemo(() => {
    if (!ruleDomains?.length) return [];
    return ruleDomains
      .slice(0, 10)
      .map((domain, index) => ({
        name: domain.domain.length > 15 ? domain.domain.slice(0, 15) + "..." : domain.domain,
        fullDomain: domain.domain,
        total: domain.totalDownload + domain.totalUpload,
        download: domain.totalDownload,
        upload: domain.totalUpload,
        connections: domain.totalConnections,
        color: CHART_COLORS[index % CHART_COLORS.length],
      }));
  }, [ruleDomains]);

  const isBackendUnavailable = backendStatus === "unhealthy";
  const emptyHint = isBackendUnavailable
    ? backendT("backendUnavailableHint")
    : t("noDataHint");

  const getPageNumbers = (currentPage: number, totalPages: number) => {
    const pages: (number | string)[] = [];
    const maxVisible = 5;
    
    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      if (currentPage <= 3) {
        for (let i = 1; i <= 4; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      } else if (currentPage >= totalPages - 2) {
        pages.push(1);
        pages.push('...');
        for (let i = totalPages - 3; i <= totalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push('...');
        for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      }
    }
    return pages;
  };

  if (chartData.length === 0) {
    return (
      <Card>
        <CardContent className="p-5 sm:p-6">
          <div className="min-h-[220px] rounded-xl border border-dashed border-border/60 bg-card/30 px-4 py-6 flex flex-col items-center justify-center text-center">
            <Waypoints className="h-8 w-8 text-muted-foreground/70 mb-2" />
            <p className="text-sm font-medium text-muted-foreground">{t("noData")}</p>
            <p className="text-xs text-muted-foreground/80 mt-1 max-w-xs">{emptyHint}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Section: Three Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Pie Chart (3 columns) */}
        <Card className="lg:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              {t("distribution")}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2 pb-4">
            <div className="h-[165px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                    isAnimationActive={false}>
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <RechartsTooltip 
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const item = payload[0].payload;
                        return (
                          <div className="bg-background border border-border p-3 rounded-lg shadow-lg">
                            <p className="font-medium text-sm mb-1">{item.name}</p>
                            <p className="text-xs text-muted-foreground">{formatBytes(item.value)}</p>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            {topRules.length > 0 && (
              <div className="mt-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider text-center">
                  Top 4
                </p>
                <div className="mt-1 space-y-1.5">
                  {topRules.map((item, idx) => {
                    const rankBadgeClass = idx === 0
                      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                      : idx === 1
                      ? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                      : idx === 2
                      ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300"
                      : "bg-muted text-muted-foreground";

                    return (
                    <div
                      key={item.rawName}
                      title={item.name}
                      className="flex items-center gap-1.5 min-w-0"
                    >
                      <span
                        className={cn(
                          "w-5 h-5 rounded-md text-[10px] font-bold flex items-center justify-center shrink-0",
                          rankBadgeClass
                        )}
                      >
                        {idx + 1}
                      </span>
                      <span
                        className="px-1.5 py-0.5 rounded-md text-[10px] font-medium text-white/90 truncate min-w-0"
                        style={{ backgroundColor: item.color }}
                      >
                        {item.name}
                      </span>
                    </div>
                  );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Middle: Rule List (4 columns) */}
        <Card className="lg:col-span-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              {t("ruleList")}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3">
            <ScrollArea className="h-[280px] pr-3">
              <div className="space-y-2">
                {chartData.map((item) => {
                const percentage = totalTraffic > 0 ? (item.value / totalTraffic) * 100 : 0;
                const barPercent = maxTotal > 0 ? (item.value / maxTotal) * 100 : 0;
                const isSelected = selectedRule === item.rawName;
                const noTraffic = !item.hasTraffic;

                // Badge color based on rank
                const badgeColor = noTraffic
                  ? "bg-muted text-muted-foreground"
                  : item.rank === 0
                  ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                  : item.rank === 1
                  ? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  : item.rank === 2
                  ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
                  : "bg-muted text-muted-foreground";

                return (
                  <button
                    key={item.rawName}
                    onClick={() => !noTraffic && handleRuleClick(item.rawName)}
                    className={cn(
                      "w-full p-2.5 rounded-xl border text-left transition-all duration-200",
                      noTraffic
                        ? "border-border/30 bg-card/30 opacity-50 cursor-default"
                        : isSelected
                        ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                        : "border-border/50 bg-card/50 hover:bg-card hover:border-primary/30"
                    )}>
                    {/* Row 1: Rank + Name + Total */}
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className={cn(
                        "w-5 h-5 rounded-md text-[10px] font-bold flex items-center justify-center shrink-0",
                        badgeColor
                      )}>
                        {noTraffic ? "–" : item.rank + 1}
                      </span>

                      <span className="flex-1 text-sm font-medium truncate" title={item.name}>
                        {item.name}
                      </span>

                      <span className="text-sm font-bold tabular-nums shrink-0">
                        {noTraffic ? (
                          <span className="text-xs font-normal text-muted-foreground">{t("noTrafficRecord")}</span>
                        ) : formatBytes(item.value)}
                      </span>
                    </div>

                    {/* Row 2: Progress bar + Stats (hidden for zero-traffic) */}
                    {!noTraffic && (
                    <div className="pl-7 space-y-1">
                      {/* Progress bar - dual color */}
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden flex">
                        <div
                          className="h-full bg-blue-500 dark:bg-blue-400"
                          style={{ width: `${item.value > 0 ? (item.download / item.value) * barPercent : 0}%` }}
                        />
                        <div
                          className="h-full bg-purple-500 dark:bg-purple-400"
                          style={{ width: `${item.value > 0 ? (item.upload / item.value) * barPercent : 0}%` }}
                        />
                      </div>
                      {/* Stats */}
                      <div className="flex flex-wrap items-center justify-between gap-1 text-xs text-muted-foreground">
                        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                          <span className="text-blue-500 dark:text-blue-400">↓ {formatBytes(item.download)}</span>
                          <span className="text-purple-500 dark:text-purple-400">↑ {formatBytes(item.upload)}</span>
                          <span className="flex items-center gap-1 tabular-nums">
                            <Link2 className="w-3 h-3" />
                            {formatNumber(item.connections)}
                          </span>
                        </div>
                        <span className="tabular-nums">{percentage.toFixed(1)}%</span>
                      </div>
                    </div>
                    )}
                  </button>
                );
              })}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Right: Top Domains Chart (5 columns) */}
        <Card className="lg:col-span-5">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                <BarChart3 className="h-4 w-4" />
                {t("topDomains")}
              </CardTitle>
              {selectedRuleData && (
                <span className="text-xs text-muted-foreground">
                  {selectedRuleData.name}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8 h-[280px]">
                <div className="h-5 w-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              </div>
            ) : domainChartData.length === 0 ? (
              <div className="h-[280px] rounded-xl border border-dashed border-border/60 bg-card/30 px-4 py-5 flex flex-col items-center justify-center text-center">
                <BarChart3 className="h-5 w-5 text-muted-foreground/70 mb-2" />
                <p className="text-sm font-medium text-muted-foreground">{domainsT("noData")}</p>
                <p className="text-xs text-muted-foreground/80 mt-1 max-w-xs">{emptyHint}</p>
              </div>
            ) : (
              <div className="h-[280px] w-full min-w-0 overflow-hidden sm:overflow-visible">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={domainChartData}
                    layout="vertical"
                    margin={{ top: 5, right: showDomainBarLabels ? 50 : 10, left: 5, bottom: 5 }}
                  >
                    <CartesianGrid 
                      strokeDasharray="3 3" 
                      stroke="#888888" 
                      opacity={0.2} 
                      horizontal={false} 
                    />
                    <XAxis
                      type="number"
                      tickFormatter={(value) => formatBytes(value, 0)}
                      tick={{ fill: "#888888", fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                type="category"
                dataKey="name"
                width={90}
                tick={{ fontSize: 10, fill: "currentColor" }}
                tickLine={false}
                axisLine={false}
              />
                    <RechartsTooltip 
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          const item = payload[0].payload;
                          return (
                            <div className="bg-background border border-border p-3 rounded-lg shadow-lg min-w-[200px] max-w-[90vw] sm:min-w-[280px]">
                              <div className="flex items-center gap-2 mb-3">
                                <Favicon domain={item.fullDomain} size="sm" />
                                <span className="font-medium text-sm text-foreground truncate max-w-[200px]">
                                  {item.fullDomain}
                                </span>
                              </div>
                              <div className="space-y-2 text-xs">
                                <div className="flex justify-between items-center">
                                  <span className="text-muted-foreground">Total Traffic</span>
                                  <span className="font-semibold text-foreground">{formatBytes(item.total)}</span>
                                </div>
                                <div className="flex justify-between items-center">
                                  <span className="text-blue-500">Download</span>
                                  <span className="text-foreground">{formatBytes(item.download)}</span>
                                </div>
                                <div className="flex justify-between items-center">
                                  <span className="text-purple-500">Upload</span>
                                  <span className="text-foreground">{formatBytes(item.upload)}</span>
                                </div>
                                <div className="flex justify-between items-center pt-1 border-t border-border/50">
                                  <span className="text-emerald-500">Connections</span>
                                  <span className="text-foreground">{formatNumber(item.connections)}</span>
                                </div>
                              </div>
                            </div>
                          );
                        }
                        return null;
                      }}
                      cursor={{ fill: "rgba(128, 128, 128, 0.1)" }} 
                    />
                    <Bar
                      dataKey="total"
                      radius={[0, 4, 4, 0]}
                      maxBarSize={24}
                      isAnimationActive={false}
                    >
                      {domainChartData.map((entry, index) => (
                        <BarCell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    {showDomainBarLabels && (
                      <LabelList
                        dataKey="total"
                        position="right"
                        content={renderCustomBarLabel}
                      />
                    )}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Unified Chain Flow Visualization - shows all rules, highlights selected */}
      <UnifiedRuleChainFlow
        selectedRule={selectedRule}
        activeBackendId={activeBackendId}
        timeRange={timeRange}
      />

      {/* Bottom Section: Domain List & IP Addresses with pagination */}
      {selectedRule && (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          {/* Simplified Tabs - no icons, no counts, like Domains page */}
          <TabsList className="glass">
            <TabsTrigger value="domains">
              {domainsT("domainList")}
            </TabsTrigger>
            <TabsTrigger value="ips">
              {ipsT("ipList")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="domains" className="mt-4">
            <Card>
              {/* Header with search */}
              <div className="p-4 border-b border-border/50">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">{domainsT("associatedDomains")}</h3>
                    <p className="text-sm text-muted-foreground">
                      {filteredDomains.length} {domainsT("domainsCount")}
                    </p>
                  </div>
                  <div className="relative">
                    <Input
                      placeholder={domainsT("search")}
                      value={domainSearch}
                      onChange={(e) => {
                        setDomainSearch(e.target.value);
                        setDomainPage(1);
                      }}
                      className="h-9 w-full sm:w-[240px] bg-secondary/50 border-0"
                    />
                  </div>
                </div>
              </div>

              <CardContent className="p-0">
                {loading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredDomains.length === 0 ? (
                  <div className="px-4 py-6">
                    <div className="min-h-[180px] rounded-xl border border-dashed border-border/60 bg-card/30 px-4 py-5 flex flex-col items-center justify-center text-center">
                      <Globe className="h-5 w-5 text-muted-foreground/70 mb-2" />
                      <p className="text-sm font-medium text-muted-foreground">
                        {domainSearch ? domainsT("noResults") : domainsT("noData")}
                      </p>
                      {!domainSearch && (
                        <p className="text-xs text-muted-foreground/80 mt-1 max-w-xs">
                          {isBackendUnavailable ? backendT("backendUnavailableHint") : domainsT("noDataHint")}
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Desktop Table Header */}
                    <div className="hidden sm:grid grid-cols-12 gap-3 px-5 py-3 bg-secondary/30 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      <div 
                        className="col-span-3 flex items-center cursor-pointer hover:text-foreground transition-colors"
                        onClick={() => handleDomainSort("domain")}
                      >
                        {domainsT("domain")}
                        <DomainSortIcon column="domain" />
                      </div>
                      <div className="col-span-2 flex items-center">
                        {domainsT("proxy")}
                      </div>
                      <div 
                        className="col-span-2 flex items-center justify-end cursor-pointer hover:text-foreground transition-colors"
                        onClick={() => handleDomainSort("totalDownload")}
                      >
                        {domainsT("download")}
                        <DomainSortIcon column="totalDownload" />
                      </div>
                      <div 
                        className="col-span-2 flex items-center justify-end cursor-pointer hover:text-foreground transition-colors"
                        onClick={() => handleDomainSort("totalUpload")}
                      >
                        {domainsT("upload")}
                        <DomainSortIcon column="totalUpload" />
                      </div>
                      <div 
                        className="col-span-1 flex items-center justify-end cursor-pointer hover:text-foreground transition-colors"
                        onClick={() => handleDomainSort("totalConnections")}
                      >
                        {domainsT("conn")}
                        <DomainSortIcon column="totalConnections" />
                      </div>
                      <div className="col-span-2 flex items-center justify-end">
                        {domainsT("ipCount")}
                      </div>
                    </div>

                    {/* Mobile Sort Bar */}
                    <div className="sm:hidden flex items-center gap-2 px-4 py-2 bg-secondary/30 overflow-x-auto scrollbar-hide">
                      {([
                        { key: "domain" as DomainSortKey, label: domainsT("domain") },
                        { key: "totalDownload" as DomainSortKey, label: domainsT("download") },
                        { key: "totalUpload" as DomainSortKey, label: domainsT("upload") },
                        { key: "totalConnections" as DomainSortKey, label: domainsT("conn") },
                      ]).map(({ key, label }) => (
                        <button
                          key={key}
                          className={cn(
                            "flex items-center gap-0.5 px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors",
                            domainSortKey === key
                              ? "bg-primary/10 text-primary"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                          onClick={() => handleDomainSort(key)}
                        >
                          {label}
                          {domainSortKey === key && (
                            domainSortOrder === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                          )}
                        </button>
                      ))}
                    </div>

                    {/* Domain List */}
                    <div className="divide-y divide-border/30">
                      {(() => {
                        const totalDomainTraffic = filteredDomains.reduce(
                          (sum, d) => sum + d.totalDownload + d.totalUpload, 0
                        );
                        return paginatedDomains.map((domain, index) => {
                          const domainTraffic = domain.totalDownload + domain.totalUpload;
                          const percent = totalDomainTraffic > 0 ? (domainTraffic / totalDomainTraffic) * 100 : 0;
                          const isExpanded = expandedDomain === domain.domain;
                          
                          return (
                            <div key={domain.domain} className="group">
                              {/* Desktop Row */}
                              <div
                                className={cn(
                                  "hidden sm:grid grid-cols-12 gap-3 px-5 py-4 items-center hover:bg-secondary/20 transition-colors cursor-pointer",
                                  isExpanded && "bg-secondary/10"
                                )}
                                style={{ animationDelay: `${index * 50}ms` }}
                                onClick={() => toggleExpandDomain(domain.domain)}
                              >
                                {/* Domain with Favicon */}
                                <div className="col-span-3 flex items-center gap-3 min-w-0">
                                  <Favicon domain={domain.domain} size="sm" className="shrink-0" />
                                  <span className="font-medium text-sm truncate" title={domain.domain}>
                                    {domain.domain}
                                  </span>
                                </div>

                                {/* Proxy */}
                                <div className="col-span-2 flex items-center gap-1.5 min-w-0">
                                  <ProxyChainBadge chains={domain.chains} />
                                </div>

                                {/* Download */}
                                <div className="col-span-2 text-right tabular-nums text-sm">
                                  <span className="text-blue-500">{formatBytes(domain.totalDownload)}</span>
                                </div>

                                {/* Upload */}
                                <div className="col-span-2 text-right tabular-nums text-sm">
                                  <span className="text-purple-500">{formatBytes(domain.totalUpload)}</span>
                                </div>

                                {/* Connections */}
                                <div className="col-span-1 flex items-center justify-end">
                                  <span className="px-2 py-0.5 rounded-full bg-secondary text-xs font-medium">
                                    {formatNumber(domain.totalConnections)}
                                  </span>
                                </div>

                                {/* IP Count - Clickable */}
                                <div className="col-span-2 flex items-center justify-end">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className={cn(
                                      "h-7 px-2 gap-1 text-xs font-medium transition-all",
                                      isExpanded 
                                        ? "bg-primary/10 text-primary hover:bg-primary/20" 
                                        : "bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary"
                                    )}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleExpandDomain(domain.domain);
                                    }}
                                  >
                                    <Server className="h-3 w-3" />
                                    {domain.ips.length}
                                    {isExpanded ? (
                                      <ChevronUp className="h-3 w-3 ml-0.5" />
                                    ) : (
                                      <ChevronDown className="h-3 w-3 ml-0.5" />
                                    )}
                                  </Button>
                                </div>
                              </div>

                              {/* Mobile Row - Card-style layout */}
                              <div
                                className={cn(
                                  "sm:hidden px-4 py-3 hover:bg-secondary/20 transition-colors cursor-pointer",
                                  isExpanded && "bg-secondary/10"
                                )}
                                onClick={() => toggleExpandDomain(domain.domain)}
                              >
                                {/* Top: Favicon + Domain + Expand */}
                                <div className="flex items-center gap-2.5 mb-2">
                                  <Favicon domain={domain.domain} size="sm" className="shrink-0" />
                                  <span className="font-medium text-sm truncate flex-1" title={domain.domain}>
                                    {domain.domain}
                                  </span>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className={cn(
                                      "h-7 px-2 gap-1 text-xs font-medium shrink-0",
                                      isExpanded 
                                        ? "bg-primary/10 text-primary" 
                                        : "bg-secondary/50 text-muted-foreground"
                                    )}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleExpandDomain(domain.domain);
                                    }}
                                  >
                                    <Server className="h-3 w-3" />
                                    {domain.ips.length}
                                    {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                                  </Button>
                                </div>

                                {/* Proxy row */}
                                {domain.chains && domain.chains.length > 0 && (
                                  <div className="flex items-center gap-1.5 mb-2 pl-[30px]">
                                    <ProxyChainBadge chains={domain.chains} truncateLabel={false} />
                                  </div>
                                )}

                                {/* Bottom: Stats row */}
                                <div className="flex items-center justify-between text-xs pl-[30px]">
                                  <span className="text-blue-500 tabular-nums">↓ {formatBytes(domain.totalDownload)}</span>
                                  <span className="text-purple-500 tabular-nums">↑ {formatBytes(domain.totalUpload)}</span>
                                  <span className="px-2 py-0.5 rounded-full bg-secondary text-muted-foreground font-medium">
                                    {formatNumber(domain.totalConnections)} {domainsT("conn")}
                                  </span>
                                </div>
                              </div>

                              {/* Expanded Details: Proxy Traffic + Associated IPs */}
                              {isExpanded && (
                                <DomainExpandedDetails
                                  domain={domain}
                                  proxyStats={domainProxyStats[domain.domain]}
                                  proxyStatsLoading={domainProxyStatsLoading === domain.domain}
                                  ipDetails={domainIPDetails[domain.domain]}
                                  ipDetailsLoading={domainIPDetailsLoading === domain.domain}
                                  labels={{
                                    proxyTraffic: domainsT("proxyTraffic"),
                                    associatedIPs: domainsT("associatedIPs"),
                                    conn: domainsT("conn"),
                                  }}
                                />
                              )}
                            </div>
                          );
                        });
                      })()}
                    </div>

                    {/* Pagination */}
                    {filteredDomains.length > 0 && (
                      <div className="p-3 border-t border-border/50 bg-secondary/20">
                        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground hover:text-foreground">
                                  <Rows3 className="h-4 w-4" />
                                  <span>{domainPageSize} / {domainsT("page")}</span>
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start">
                                {PAGE_SIZE_OPTIONS.map((size) => (
                                  <DropdownMenuItem
                                    key={size}
                                    onClick={() => {
                                      setDomainPageSize(size);
                                      setDomainPage(1);
                                    }}
                                    className={domainPageSize === size ? "bg-primary/10" : ""}
                                  >
                                    {size} / {domainsT("page")}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <span className="text-sm text-muted-foreground">
                              {domainsT("total")} {filteredDomains.length}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <p className="text-xs text-muted-foreground">
                              {(domainPage - 1) * domainPageSize + 1}-{Math.min(domainPage * domainPageSize, filteredDomains.length)} / {filteredDomains.length}
                            </p>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => setDomainPage(p => Math.max(1, p - 1))}
                                disabled={domainPage === 1}
                              >
                                <ChevronLeft className="h-4 w-4" />
                              </Button>
                              {getPageNumbers(domainPage, domainTotalPages).map((page, idx) => (
                                page === '...' ? (
                                  <span key={`ellipsis-${idx}`} className="px-1 text-muted-foreground text-xs">...</span>
                                ) : (
                                  <Button
                                    key={page}
                                    variant={domainPage === page ? "default" : "ghost"}
                                    size="sm"
                                    className="h-8 w-8 px-0 text-xs"
                                    onClick={() => setDomainPage(page as number)}
                                  >
                                    {page}
                                  </Button>
                                )
                              ))}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => setDomainPage(p => Math.min(domainTotalPages, p + 1))}
                                disabled={domainPage === domainTotalPages}
                              >
                                <ChevronRight className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="ips" className="mt-4">
            <Card>
              {/* Header with search */}
              <div className="p-4 border-b border-border/50">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">{ipsT("associatedIPs")}</h3>
                    <p className="text-sm text-muted-foreground">
                      {filteredIPs.length} IPs
                    </p>
                  </div>
                  <div className="relative">
                    <Input
                      placeholder={ipsT("search")}
                      value={ipSearch}
                      onChange={(e) => {
                        setIpSearch(e.target.value);
                        setIpPage(1);
                      }}
                      className="h-9 w-full sm:w-[240px] bg-secondary/50 border-0"
                    />
                  </div>
                </div>
              </div>

              <CardContent className="p-0">
                {loading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredIPs.length === 0 ? (
                  <div className="px-4 py-6">
                    <div className="min-h-[180px] rounded-xl border border-dashed border-border/60 bg-card/30 px-4 py-5 flex flex-col items-center justify-center text-center">
                      <Server className="h-5 w-5 text-muted-foreground/70 mb-2" />
                      <p className="text-sm font-medium text-muted-foreground">
                        {ipSearch ? ipsT("noResults") : ipsT("noData")}
                      </p>
                      {!ipSearch && (
                        <p className="text-xs text-muted-foreground/80 mt-1 max-w-xs">
                          {isBackendUnavailable ? backendT("backendUnavailableHint") : ipsT("noDataHint")}
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Desktop Table Header */}
                    <div className="hidden sm:grid grid-cols-12 gap-3 px-5 py-3 bg-secondary/30 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      <div 
                        className="col-span-3 flex items-center cursor-pointer hover:text-foreground transition-colors"
                        onClick={() => handleIPSort("ip")}
                      >
                        {ipsT("ipAddress")}
                        <IPSortIcon column="ip" />
                      </div>
                      <div className="col-span-2 flex items-center">
                        {ipsT("proxy")}
                      </div>
                      <div className="col-span-2 flex items-center">
                        {ipsT("location")}
                      </div>
                      <div 
                        className="col-span-2 flex items-center justify-end cursor-pointer hover:text-foreground transition-colors"
                        onClick={() => handleIPSort("totalDownload")}
                      >
                        {ipsT("download")}
                        <IPSortIcon column="totalDownload" />
                      </div>
                      <div 
                        className="col-span-1 flex items-center justify-end cursor-pointer hover:text-foreground transition-colors"
                        onClick={() => handleIPSort("totalUpload")}
                      >
                        {ipsT("upload")}
                        <IPSortIcon column="totalUpload" />
                      </div>
                      <div 
                        className="col-span-1 flex items-center justify-end cursor-pointer hover:text-foreground transition-colors"
                        onClick={() => handleIPSort("totalConnections")}
                      >
                        {ipsT("conn")}
                        <IPSortIcon column="totalConnections" />
                      </div>
                      <div className="col-span-1 flex items-center justify-end">
                        {ipsT("domainCount")}
                      </div>
                    </div>

                    {/* Mobile Sort Bar */}
                    <div className="sm:hidden flex items-center gap-2 px-4 py-2 bg-secondary/30 overflow-x-auto scrollbar-hide">
                      {([
                        { key: "ip" as IPSortKey, label: ipsT("ipAddress") },
                        { key: "totalDownload" as IPSortKey, label: ipsT("download") },
                        { key: "totalUpload" as IPSortKey, label: ipsT("upload") },
                        { key: "totalConnections" as IPSortKey, label: ipsT("conn") },
                      ]).map(({ key, label }) => (
                        <button
                          key={key}
                          className={cn(
                            "flex items-center gap-0.5 px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors",
                            ipSortKey === key
                              ? "bg-primary/10 text-primary"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                          onClick={() => handleIPSort(key)}
                        >
                          {label}
                          {ipSortKey === key && (
                            ipSortOrder === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                          )}
                        </button>
                      ))}
                    </div>

                    {/* IP List */}
                    <div className="divide-y divide-border/30">
                      {(() => {
                        const totalIPTraffic = filteredIPs.reduce(
                          (sum, ip) => sum + ip.totalDownload + ip.totalUpload, 0
                        );
                        return paginatedIPs.map((ip, index) => {
                          const ipTraffic = ip.totalDownload + ip.totalUpload;
                          const percent = totalIPTraffic > 0 ? (ipTraffic / totalIPTraffic) * 100 : 0;
                          const isExpanded = expandedIP === ip.ip;
                          const ipColor = getIPColor(ip.ip);
                          
                          return (
                            <div key={ip.ip} className="group">
                              {/* Desktop Row */}
                              <div
                                className={cn(
                                  "hidden sm:grid grid-cols-12 gap-3 px-5 py-4 items-center hover:bg-secondary/20 transition-colors cursor-pointer",
                                  isExpanded && "bg-secondary/10"
                                )}
                                style={{ animationDelay: `${index * 50}ms` }}
                                onClick={() => toggleExpandIP(ip.ip)}
                              >
                                {/* IP with Icon */}
                                <div className="col-span-3 flex items-center gap-3 min-w-0">
                                  <div className={`w-5 h-5 rounded-md ${ipColor.bg} ${ipColor.text} flex items-center justify-center shrink-0`}>
                                    <Server className="w-3 h-3" />
                                  </div>
                                  <code className="text-sm font-mono truncate">{ip.ip}</code>
                                </div>

                                {/* Proxy */}
                                <div className="col-span-2 flex items-center gap-1.5 min-w-0">
                                  <ProxyChainBadge chains={ip.chains} />
                                </div>

                                {/* Location */}
                                <div className="col-span-2 flex items-center gap-1.5 min-w-0">
                                    {ip.geoIP && ip.geoIP.length > 0 ? (
                                      <>
                                        <CountryFlag country={ip.geoIP[0]} className="h-3.5 w-5" title={ip.geoIP[1] || ip.geoIP[0]} />
                                      <span className="text-xs whitespace-nowrap">{ip.geoIP[1] || ip.geoIP[0]}</span>
                                    </>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">-</span>
                                  )}
                                </div>

                                {/* Download */}
                                <div className="col-span-2 text-right tabular-nums text-sm">
                                  <span className="text-blue-500">{formatBytes(ip.totalDownload)}</span>
                                </div>

                                {/* Upload */}
                                <div className="col-span-1 text-right tabular-nums text-sm">
                                  <span className="text-purple-500">{formatBytes(ip.totalUpload)}</span>
                                </div>

                                {/* Connections */}
                                <div className="col-span-1 flex items-center justify-end">
                                  <span className="px-2 py-0.5 rounded-full bg-secondary text-xs font-medium">
                                    {formatNumber(ip.totalConnections)}
                                  </span>
                                </div>

                                {/* Domains Count - Clickable */}
                                <div className="col-span-1 flex items-center justify-end">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className={cn(
                                      "h-7 px-2 gap-1 text-xs font-medium transition-all",
                                      isExpanded 
                                        ? "bg-primary/10 text-primary hover:bg-primary/20" 
                                        : "bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary"
                                    )}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleExpandIP(ip.ip);
                                    }}
                                  >
                                    <Link2 className="h-3 w-3" />
                                    {ip.domains.length}
                                    {isExpanded ? (
                                      <ChevronUp className="h-3 w-3 ml-0.5" />
                                    ) : (
                                      <ChevronDown className="h-3 w-3 ml-0.5" />
                                    )}
                                  </Button>
                                </div>
                              </div>

                              {/* Mobile Row - Card-style layout */}
                              <div
                                className={cn(
                                  "sm:hidden px-4 py-3 hover:bg-secondary/20 transition-colors cursor-pointer",
                                  isExpanded && "bg-secondary/10"
                                )}
                                onClick={() => toggleExpandIP(ip.ip)}
                              >
                                {/* Top: IP Icon + IP + Location + Expand */}
                                <div className="flex items-center gap-2.5 mb-2">
                                  <div className={`w-5 h-5 rounded-md ${ipColor.bg} ${ipColor.text} flex items-center justify-center shrink-0`}>
                                    <Server className="w-3 h-3" />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <code className="text-sm font-medium truncate block">{ip.ip}</code>
                                    {ip.geoIP && ip.geoIP.length > 0 && (
                                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                        <CountryFlag country={ip.geoIP[0]} className="h-3.5 w-5" />
                                        <span className="truncate">{ip.geoIP[1] || ip.geoIP[0]}</span>
                                      </div>
                                    )}
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className={cn(
                                      "h-7 px-2 gap-1 text-xs font-medium shrink-0",
                                      isExpanded 
                                        ? "bg-primary/10 text-primary" 
                                        : "bg-secondary/50 text-muted-foreground"
                                    )}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleExpandIP(ip.ip);
                                    }}
                                  >
                                    <Link2 className="h-3 w-3" />
                                    {ip.domains.length}
                                    {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                                  </Button>
                                </div>

                                {/* Proxy row */}
                                {ip.chains && ip.chains.length > 0 && (
                                  <div className="flex items-center gap-1.5 mb-2 pl-[30px]">
                                    <ProxyChainBadge chains={ip.chains} truncateLabel={false} />
                                  </div>
                                )}

                                {/* Bottom: Stats row */}
                                <div className="flex items-center justify-between text-xs pl-[30px]">
                                  <span className="text-blue-500 tabular-nums">↓ {formatBytes(ip.totalDownload)}</span>
                                  <span className="text-purple-500 tabular-nums">↑ {formatBytes(ip.totalUpload)}</span>
                                  <span className="px-2 py-0.5 rounded-full bg-secondary text-muted-foreground font-medium">
                                    {formatNumber(ip.totalConnections)} {ipsT("conn")}
                                  </span>
                                </div>
                              </div>

                              {/* Expanded Details: Proxy Traffic + Associated Domains */}
                              {isExpanded && (
                                <IPExpandedDetails
                                  ip={ip}
                                  proxyStats={ipProxyStats[ip.ip]}
                                  proxyStatsLoading={ipProxyStatsLoading === ip.ip}
                                  domainDetails={ipDomainDetails[ip.ip]}
                                  domainDetailsLoading={ipDomainDetailsLoading === ip.ip}
                                  associatedDomainsIcon="link"
                                  labels={{
                                    proxyTraffic: ipsT("proxyTraffic"),
                                    associatedDomains: ipsT("associatedDomains"),
                                    conn: ipsT("conn"),
                                  }}
                                />
                              )}
                            </div>
                          );
                        });
                      })()}
                    </div>

                    {/* Pagination */}
                    {filteredIPs.length > 0 && (
                      <div className="p-3 border-t border-border/50 bg-secondary/20">
                        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground hover:text-foreground">
                                  <Rows3 className="h-4 w-4" />
                                  <span>{ipPageSize} / {ipsT("page")}</span>
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start">
                                {PAGE_SIZE_OPTIONS.map((size) => (
                                  <DropdownMenuItem
                                    key={size}
                                    onClick={() => {
                                      setIpPageSize(size);
                                      setIpPage(1);
                                    }}
                                    className={ipPageSize === size ? "bg-primary/10" : ""}
                                  >
                                    {size} / {ipsT("page")}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <span className="text-sm text-muted-foreground">
                              {ipsT("total")} {filteredIPs.length}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <p className="text-xs text-muted-foreground">
                              {(ipPage - 1) * ipPageSize + 1}-{Math.min(ipPage * ipPageSize, filteredIPs.length)} / {filteredIPs.length}
                            </p>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => setIpPage(p => Math.max(1, p - 1))}
                                disabled={ipPage === 1}
                              >
                                <ChevronLeft className="h-4 w-4" />
                              </Button>
                              {getPageNumbers(ipPage, ipTotalPages).map((page, idx) => (
                                page === '...' ? (
                                  <span key={`ellipsis-${idx}`} className="px-1 text-muted-foreground text-xs">...</span>
                                ) : (
                                  <Button
                                    key={page}
                                    variant={ipPage === page ? "default" : "ghost"}
                                    size="sm"
                                    className="h-8 w-8 px-0 text-xs"
                                    onClick={() => setIpPage(page as number)}
                                  >
                                    {page}
                                  </Button>
                                )
                              ))}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => setIpPage(p => Math.min(ipTotalPages, p + 1))}
                                disabled={ipPage === ipTotalPages}
                              >
                                <ChevronRight className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
