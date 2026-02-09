"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Rows3,
  ArrowUpDown,
  ArrowDown,
  ArrowUp,
  Globe,
  ChevronDown,
  ChevronUp,
  Server,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CountryFlag } from "@/components/country-flag";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatBytes, formatNumber } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { api, type TimeRange } from "@/lib/api";
import { IPExpandedDetails } from "@/components/stats-tables/expanded-details";
import { ProxyChainBadge } from "@/components/proxy-chain-badge";
import {
  PAGE_SIZE_OPTIONS,
  getIPGradient,
  getPageNumbers,
  type PageSize,
  type IPSortKey,
  type SortOrder,
} from "@/lib/stats-utils";
import type { IPStats, ProxyTrafficStats, DomainStats } from "@clashmaster/shared";

interface IPStatsTableProps {
  ips: IPStats[];
  loading?: boolean;
  title?: string;
  showHeader?: boolean;
  activeBackendId?: number;
  timeRange?: TimeRange;
  sourceIP?: string;
  sourceChain?: string;
  richExpand?: boolean;
  showProxyColumn?: boolean;
  showProxyTrafficInExpand?: boolean;
}

export function IPStatsTable({
  ips,
  loading = false,
  title,
  showHeader = true,
  activeBackendId,
  timeRange,
  sourceIP,
  sourceChain,
  richExpand = false,
  showProxyColumn = true,
  showProxyTrafficInExpand = true,
}: IPStatsTableProps) {
  const t = useTranslations("ips");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<IPSortKey>("totalDownload");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [expandedIP, setExpandedIP] = useState<string | null>(null);

  const [proxyStats, setProxyStats] = useState<Record<string, ProxyTrafficStats[]>>({});
  const [proxyStatsLoading, setProxyStatsLoading] = useState<string | null>(null);
  const [domainDetails, setDomainDetails] = useState<Record<string, DomainStats[]>>({});
  const [domainDetailsLoading, setDomainDetailsLoading] = useState<string | null>(null);

  useEffect(() => {
    // Context switch (backend/device/proxy/rule binding change): collapse.
    setExpandedIP(null);
    setProxyStats({});
    setDomainDetails({});
    setProxyStatsLoading(null);
    setDomainDetailsLoading(null);
  }, [activeBackendId, sourceIP, sourceChain, richExpand]);

  const fetchProxyStats = useCallback(
    async (ip: string, options?: { force?: boolean; background?: boolean }) => {
      const force = options?.force ?? false;
      const background = options?.background ?? false;
      const hasCached = !!proxyStats[ip];
      if (!richExpand || (!force && hasCached)) return;
      if (!background || !hasCached) {
        setProxyStatsLoading(ip);
      }
      try {
        const stats = await api.getIPProxyStats(
          ip,
          activeBackendId,
          timeRange,
          sourceIP,
          sourceChain,
        );
        setProxyStats((prev) => ({ ...prev, [ip]: stats }));
      } catch (err) {
        console.error(`Failed to fetch proxy stats for ${ip}:`, err);
        setProxyStats((prev) => ({ ...prev, [ip]: [] }));
      } finally {
        if (proxyStatsLoading === ip) {
          setProxyStatsLoading(null);
        }
      }
    },
    [proxyStats, activeBackendId, timeRange, sourceIP, sourceChain, richExpand, proxyStatsLoading],
  );

  const fetchDomainDetails = useCallback(
    async (ip: string, options?: { force?: boolean; background?: boolean }) => {
      const force = options?.force ?? false;
      const background = options?.background ?? false;
      const hasCached = !!domainDetails[ip];
      if (!richExpand || (!force && hasCached)) return;
      if (!background || !hasCached) {
        setDomainDetailsLoading(ip);
      }
      try {
        const details = await api.getIPDomainDetails(
          ip,
          activeBackendId,
          timeRange,
          sourceIP,
          undefined,
          sourceChain,
        );
        setDomainDetails((prev) => ({ ...prev, [ip]: details }));
      } catch (err) {
        console.error(`Failed to fetch domain details for ${ip}:`, err);
        setDomainDetails((prev) => ({ ...prev, [ip]: [] }));
      } finally {
        if (domainDetailsLoading === ip) {
          setDomainDetailsLoading(null);
        }
      }
    },
    [domainDetails, activeBackendId, timeRange, sourceIP, sourceChain, richExpand, domainDetailsLoading],
  );

  useEffect(() => {
    if (!expandedIP || !richExpand) return;
    fetchProxyStats(expandedIP);
    fetchDomainDetails(expandedIP);
  }, [expandedIP, richExpand, fetchProxyStats, fetchDomainDetails]);

  useEffect(() => {
    if (!expandedIP || !richExpand) return;
    fetchProxyStats(expandedIP, { force: true, background: true });
    fetchDomainDetails(expandedIP, { force: true, background: true });
  }, [timeRange?.start, timeRange?.end, expandedIP, richExpand, fetchProxyStats, fetchDomainDetails]);

  const handleSort = (key: IPSortKey) => {
    if (sortKey === key) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortOrder("desc");
    }
    setPage(1);
  };

  const toggleExpand = (ip: string) => {
    const newExpanded = expandedIP === ip ? null : ip;
    setExpandedIP(newExpanded);
    if (newExpanded && richExpand) {
      fetchProxyStats(newExpanded);
      fetchDomainDetails(newExpanded);
    }
  };

  const SortIcon = ({ column }: { column: IPSortKey }) => {
    if (sortKey !== column) return <ArrowUpDown className="ml-1 h-3 w-3 text-muted-foreground" />;
    return sortOrder === "asc" ? (
      <ArrowUp className="ml-1 h-3 w-3 text-primary" />
    ) : (
      <ArrowDown className="ml-1 h-3 w-3 text-primary" />
    );
  };

  const filteredIPs = useMemo(() => {
    let result = [...ips];
    if (search) {
      const lower = search.toLowerCase();
      result = result.filter((ip) => ip.ip.toLowerCase().includes(lower));
    }
    result.sort((a, b) => {
      const aVal = a[sortKey] ?? "";
      const bVal = b[sortKey] ?? "";
      if (sortOrder === "asc") {
        return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      }
      return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
    });
    return result;
  }, [ips, search, sortKey, sortOrder]);

  const paginatedIPs = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredIPs.slice(start, start + pageSize);
  }, [filteredIPs, page, pageSize]);

  const totalPages = Math.ceil(filteredIPs.length / pageSize);
  const ipColumnClass = showProxyColumn ? "col-span-3" : "col-span-4";
  const locationColumnClass = "col-span-2";
  const domainCountColumnClass = showProxyColumn ? "col-span-1" : "col-span-2";

  return (
    <Card>
      {showHeader && (
        <div className="p-4 border-b border-border/50">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">{title || t("associatedIPs")}</h3>
              <p className="text-sm text-muted-foreground">
                {filteredIPs.length} {t("ipsCount")}
              </p>
            </div>
            <div className="relative">
              <Input
                placeholder={t("search")}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="h-9 w-full sm:w-[240px] bg-secondary/50 border-0"
              />
            </div>
          </div>
        </div>
      )}

      <CardContent className="p-0">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filteredIPs.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            {search ? t("noResults") : t("noData")}
          </div>
        ) : (
          <>
            <div className="hidden sm:grid grid-cols-12 gap-3 px-5 py-3 bg-secondary/30 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <div
                className={cn(
                  ipColumnClass,
                  "flex items-center cursor-pointer hover:text-foreground transition-colors",
                )}
                onClick={() => handleSort("ip")}
              >
                {t("ip")}
                <SortIcon column="ip" />
              </div>
              {showProxyColumn && (
                <div className="col-span-2 flex items-center">{t("proxy")}</div>
              )}
              <div className={cn(locationColumnClass, "flex items-center")}>{t("location")}</div>
              <div
                className="col-span-2 flex items-center justify-end cursor-pointer hover:text-foreground transition-colors"
                onClick={() => handleSort("totalDownload")}
              >
                {t("download")}
                <SortIcon column="totalDownload" />
              </div>
              <div
                className="col-span-1 flex items-center justify-end cursor-pointer hover:text-foreground transition-colors"
                onClick={() => handleSort("totalUpload")}
              >
                {t("upload")}
                <SortIcon column="totalUpload" />
              </div>
              <div
                className="col-span-1 flex items-center justify-end cursor-pointer hover:text-foreground transition-colors"
                onClick={() => handleSort("totalConnections")}
              >
                {t("conn")}
                <SortIcon column="totalConnections" />
              </div>
              <div className={cn(domainCountColumnClass, "flex items-center justify-end")}>
                {t("domainCount")}
              </div>
            </div>

            <div className="sm:hidden flex items-center gap-2 px-4 py-2 bg-secondary/30 overflow-x-auto scrollbar-hide">
              {([
                { key: "ip" as IPSortKey, label: t("ip") },
                { key: "totalDownload" as IPSortKey, label: t("download") },
                { key: "totalUpload" as IPSortKey, label: t("upload") },
                { key: "totalConnections" as IPSortKey, label: t("conn") },
              ]).map(({ key, label }) => (
                <button
                  key={key}
                  className={cn(
                    "flex items-center gap-0.5 px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors",
                    sortKey === key
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => handleSort(key)}
                >
                  {label}
                  {sortKey === key &&
                    (sortOrder === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                </button>
              ))}
            </div>

            <div className="divide-y divide-border/30">
              {paginatedIPs.map((ip) => {
                const isExpanded = expandedIP === ip.ip;

                return (
                  <div key={ip.ip} className="group">
                    <div
                      className={cn(
                        "hidden sm:grid grid-cols-12 gap-3 px-5 py-4 items-center hover:bg-secondary/20 transition-colors cursor-pointer",
                        isExpanded && "bg-secondary/10",
                      )}
                      onClick={() => toggleExpand(ip.ip)}
                    >
                      <div className={cn(ipColumnClass, "flex items-center gap-3 min-w-0")}>
                        <div className={`w-5 h-5 rounded-md bg-gradient-to-br ${getIPGradient(ip.ip)} flex items-center justify-center shrink-0`}>
                          <Server className="w-3 h-3 text-white" />
                        </div>
                        <code className="font-mono text-sm truncate">{ip.ip}</code>
                      </div>

                      {showProxyColumn && (
                        <div className="col-span-2 flex items-center gap-1.5 min-w-0">
                          <ProxyChainBadge chains={ip.chains} />
                        </div>
                      )}

                      <div className={cn(locationColumnClass, "flex items-center gap-1.5 min-w-0")}>
                        {ip.geoIP && ip.geoIP.length > 0 ? (
                          <>
                            <CountryFlag country={ip.geoIP[0]} className="h-3.5 w-5" title={ip.geoIP[1] || ip.geoIP[0]} />
                            <span className="text-xs whitespace-nowrap">{ip.geoIP[1] || ip.geoIP[0]}</span>
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </div>

                      <div className="col-span-2 text-right tabular-nums text-sm">
                        <span className="text-blue-500">{formatBytes(ip.totalDownload)}</span>
                      </div>

                      <div className="col-span-1 text-right tabular-nums text-sm">
                        <span className="text-purple-500">{formatBytes(ip.totalUpload)}</span>
                      </div>

                      <div className="col-span-1 flex items-center justify-end">
                        <span className="px-2 py-0.5 rounded-full bg-secondary text-xs font-medium">
                          {formatNumber(ip.totalConnections)}
                        </span>
                      </div>

                      <div className={cn(domainCountColumnClass, "flex items-center justify-end")}>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={cn(
                            "h-7 px-2 gap-1 text-xs font-medium transition-all",
                            isExpanded
                              ? "bg-primary/10 text-primary hover:bg-primary/20"
                              : "bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary",
                          )}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(ip.ip);
                          }}
                        >
                          <Globe className="h-3 w-3" />
                          {ip.domains?.length || 0}
                          {isExpanded ? (
                            <ChevronUp className="h-3 w-3 ml-0.5" />
                          ) : (
                            <ChevronDown className="h-3 w-3 ml-0.5" />
                          )}
                        </Button>
                      </div>
                    </div>

                    <div
                      className={cn(
                        "sm:hidden px-4 py-3 hover:bg-secondary/20 transition-colors cursor-pointer",
                        isExpanded && "bg-secondary/10",
                      )}
                      onClick={() => toggleExpand(ip.ip)}
                    >
                      <div className="flex items-center gap-2.5 mb-2">
                        <div className={`w-5 h-5 rounded-md bg-gradient-to-br ${getIPGradient(ip.ip)} flex items-center justify-center shrink-0`}>
                          <Server className="w-2.5 h-2.5 text-white" />
                        </div>
                        <code className="font-mono text-sm flex-1 truncate">{ip.ip}</code>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={cn(
                            "h-7 px-2 gap-1 text-xs font-medium shrink-0",
                            isExpanded ? "bg-primary/10 text-primary" : "bg-secondary/50 text-muted-foreground",
                          )}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(ip.ip);
                          }}
                        >
                          <Globe className="h-3 w-3" />
                          {ip.domains?.length || 0}
                          {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        </Button>
                      </div>

                      <div className="flex items-center gap-2 mb-2 pl-[30px] flex-wrap">
                        {ip.geoIP && ip.geoIP.length > 0 && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                            <CountryFlag country={ip.geoIP[0]} className="h-3.5 w-5" />
                            <span className="truncate">{ip.geoIP[1] || ip.geoIP[0]}</span>
                          </span>
                        )}
                        {showProxyColumn && ip.chains && ip.chains.length > 0 && (
                          <ProxyChainBadge chains={ip.chains} truncateLabel={false} />
                        )}
                      </div>

                      <div className="flex items-center justify-between text-xs pl-[30px]">
                        <span className="text-blue-500 tabular-nums">↓ {formatBytes(ip.totalDownload)}</span>
                        <span className="text-purple-500 tabular-nums">↑ {formatBytes(ip.totalUpload)}</span>
                        <span className="px-2 py-0.5 rounded-full bg-secondary text-muted-foreground font-medium">
                          {formatNumber(ip.totalConnections)} {t("conn")}
                        </span>
                      </div>
                    </div>

                    {isExpanded && (
                      <IPExpandedDetails
                        ip={ip}
                        richExpand={richExpand}
                        proxyStats={proxyStats[ip.ip]}
                        proxyStatsLoading={proxyStatsLoading === ip.ip}
                        domainDetails={domainDetails[ip.ip]}
                        domainDetailsLoading={domainDetailsLoading === ip.ip}
                        associatedDomainsIcon="link"
                        labels={{
                          proxyTraffic: t("proxyTraffic"),
                          associatedDomains: t("associatedDomains"),
                          conn: t("conn"),
                        }}
                        showProxyTraffic={showProxyTrafficInExpand}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {filteredIPs.length > 0 && (
              <div className="p-3 border-t border-border/50 bg-secondary/20">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground hover:text-foreground">
                          <Rows3 className="h-4 w-4" />
                          <span>{pageSize} / {t("page")}</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        {PAGE_SIZE_OPTIONS.map((size) => (
                          <DropdownMenuItem
                            key={size}
                            onClick={() => {
                              setPageSize(size);
                              setPage(1);
                            }}
                            className={pageSize === size ? "bg-primary/10" : ""}
                          >
                            {size} / {t("page")}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <span className="text-sm text-muted-foreground">
                      {t("total")} {filteredIPs.length}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-muted-foreground">
                      {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, filteredIPs.length)} / {filteredIPs.length}
                    </p>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page === 1}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      {getPageNumbers(page, totalPages).map((p, idx) =>
                        p === "..." ? (
                          <span key={`ellipsis-${idx}`} className="px-1 text-muted-foreground text-xs">
                            ...
                          </span>
                        ) : (
                          <Button
                            key={p}
                            variant={page === p ? "default" : "ghost"}
                            size="sm"
                            className="h-8 w-8 px-0 text-xs"
                            onClick={() => setPage(p as number)}
                          >
                            {p}
                          </Button>
                        ),
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                        disabled={page === totalPages}
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
  );
}
