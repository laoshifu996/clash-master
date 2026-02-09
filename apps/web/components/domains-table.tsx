"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Search, ArrowUpDown, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Rows3, ChevronDown, ChevronUp, Server, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Favicon } from "@/components/favicon";
import { DomainExpandedDetails } from "@/components/stats-tables/expanded-details";
import { ProxyChainBadge } from "@/components/proxy-chain-badge";
import { formatBytes, formatNumber, formatDuration } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { DomainStats, ProxyTrafficStats, IPStats } from "@clashmaster/shared";
import { api, type TimeRange } from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface DomainsTableProps {
  activeBackendId?: number;
  timeRange?: TimeRange;
}

type SortKey = "domain" | "totalDownload" | "totalUpload" | "totalConnections" | "lastSeen";
type SortOrder = "asc" | "desc";

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];

export function DomainsTable({ activeBackendId, timeRange }: DomainsTableProps) {
  const t = useTranslations("domains");
  const [data, setData] = useState<DomainStats[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("totalDownload");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [expandedDomain, setExpandedDomain] = useState<string | null>(null);
  const [proxyStats, setProxyStats] = useState<Record<string, ProxyTrafficStats[]>>({});
  const [proxyStatsLoading, setProxyStatsLoading] = useState<string | null>(null);
  const [ipDetails, setIPDetails] = useState<Record<string, IPStats[]>>({});
  const [ipDetailsLoading, setIPDetailsLoading] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search input
  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
      setCurrentPage(1);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  // Fetch data from server
  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      setLoading(true);
      try {
        const result = await api.getDomains(activeBackendId, {
          offset: (currentPage - 1) * pageSize,
          limit: pageSize,
          sortBy: sortKey,
          sortOrder,
          search: debouncedSearch || undefined,
          start: timeRange?.start,
          end: timeRange?.end,
        });
        if (!cancelled) {
          setData(result.data);
          setTotal(result.total);
        }
      } catch (err) {
        console.error("Failed to fetch domains:", err);
        if (!cancelled) {
          setData([]);
          setTotal(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchData();
    return () => { cancelled = true; };
  }, [activeBackendId, currentPage, pageSize, sortKey, sortOrder, debouncedSearch, timeRange]);

  useEffect(() => {
    // Backend switch means a different data universe, collapse safely.
    setExpandedDomain(null);
    setProxyStats({});
    setIPDetails({});
  }, [activeBackendId]);

  // Fetch proxy stats when a domain is expanded
  const fetchProxyStats = useCallback(async (
    domain: string,
    options?: { force?: boolean; background?: boolean },
  ) => {
    const force = options?.force ?? false;
    const background = options?.background ?? false;
    const hasCached = !!proxyStats[domain];
    if (!force && hasCached) return;
    if (!background || !hasCached) {
      setProxyStatsLoading(domain);
    }
    try {
      const stats = await api.getDomainProxyStats(
        domain,
        activeBackendId,
        timeRange,
      );
      setProxyStats(prev => ({ ...prev, [domain]: stats }));
    } catch (err) {
      console.error(`Failed to fetch proxy stats for ${domain}:`, err);
      setProxyStats(prev => ({ ...prev, [domain]: [] }));
    } finally {
      if (proxyStatsLoading === domain) {
        setProxyStatsLoading(null);
      }
    }
  }, [proxyStats, activeBackendId, timeRange, proxyStatsLoading]);

  // Fetch IP details when a domain is expanded
  const fetchIPDetails = useCallback(async (
    domain: string,
    options?: { force?: boolean; background?: boolean },
  ) => {
    const force = options?.force ?? false;
    const background = options?.background ?? false;
    const hasCached = !!ipDetails[domain];
    if (!force && hasCached) return;
    if (!background || !hasCached) {
      setIPDetailsLoading(domain);
    }
    try {
      const details = await api.getDomainIPDetails(
        domain,
        activeBackendId,
        timeRange,
      );
      setIPDetails(prev => ({ ...prev, [domain]: details }));
    } catch (err) {
      console.error(`Failed to fetch IP details for ${domain}:`, err);
      setIPDetails(prev => ({ ...prev, [domain]: [] }));
    } finally {
      if (ipDetailsLoading === domain) {
        setIPDetailsLoading(null);
      }
    }
  }, [ipDetails, activeBackendId, timeRange, ipDetailsLoading]);

  useEffect(() => {
    if (!expandedDomain) return;
    fetchProxyStats(expandedDomain);
    fetchIPDetails(expandedDomain);
  }, [expandedDomain, fetchProxyStats, fetchIPDetails]);

  useEffect(() => {
    if (!expandedDomain) return;
    fetchProxyStats(expandedDomain, { force: true, background: true });
    fetchIPDetails(expandedDomain, { force: true, background: true });
  }, [timeRange?.start, timeRange?.end, expandedDomain, fetchProxyStats, fetchIPDetails]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortOrder("desc");
    }
    setCurrentPage(1);
  };

  const totalPages = Math.ceil(total / pageSize);

  const handleSearchChange = (value: string) => {
    setSearch(value);
  };

  const handlePageSizeChange = (size: PageSize) => {
    setPageSize(size);
    setCurrentPage(1);
  };

  const toggleExpand = (domain: string) => {
    const newExpanded = expandedDomain === domain ? null : domain;
    setExpandedDomain(newExpanded);
    if (newExpanded) {
      fetchProxyStats(newExpanded);
      fetchIPDetails(newExpanded);
    }
  };

  const SortIcon = ({ column }: { column: SortKey }) => {
    if (sortKey !== column) return <ArrowUpDown className="ml-1 h-3 w-3 text-muted-foreground" />;
    return sortOrder === "asc" ? (
      <ArrowUp className="ml-1 h-3 w-3 text-primary" />
    ) : (
      <ArrowDown className="ml-1 h-3 w-3 text-primary" />
    );
  };

  // Generate page numbers to display
  const getPageNumbers = () => {
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

  return (
    <div className="glass-card rounded-2xl overflow-hidden overflow-x-hidden">
      {/* Header */}
      <div className="p-4 sm:p-5 border-b border-border/50">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">{t("title")}</h3>
            <p className="text-sm text-muted-foreground">
              {total} {t("domainsCount")}
            </p>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t("search")}
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-10 h-10 w-full sm:w-[240px] bg-secondary/50 border-0"
            />
          </div>
        </div>
      </div>

      {/* Desktop Table Header - Hidden on mobile */}
      <div className="hidden sm:grid grid-cols-12 gap-3 px-5 py-3 bg-secondary/30 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        <div
          className="col-span-3 flex items-center cursor-pointer hover:text-foreground transition-colors"
          onClick={() => handleSort("domain")}
        >
          {t("domain")}
          <SortIcon column="domain" />
        </div>
        <div className="col-span-2 flex items-center">
          {t("proxy")}
        </div>
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
        <div className="col-span-1 flex items-center justify-end">
          {t("last")}
        </div>
        <div className="col-span-2 flex items-center justify-end">
          {t("ipCount")}
        </div>
      </div>

      {/* Mobile Sort Bar - Shown only on mobile */}
      <div className="sm:hidden flex items-center gap-2 px-4 py-2 bg-secondary/30 overflow-x-auto scrollbar-hide">
        {([
          { key: "domain" as SortKey, label: t("domain") },
          { key: "totalDownload" as SortKey, label: t("download") },
          { key: "totalUpload" as SortKey, label: t("upload") },
          { key: "totalConnections" as SortKey, label: t("conn") },
        ]).map(({ key, label }) => (
          <button
            key={key}
            className={cn(
              "flex items-center gap-0.5 px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors",
              sortKey === key
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => handleSort(key)}
          >
            {label}
            {sortKey === key && (
              sortOrder === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
            )}
          </button>
        ))}
      </div>

      {/* Table Body */}
      <div className="divide-y divide-border/30 min-h-[300px]">
        {loading && data.length === 0 ? (
          <div className="px-5 py-12 text-center text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
          </div>
        ) : data.length === 0 ? (
          <div className="px-5 py-12 text-center text-muted-foreground">
            {t("noResults")}
          </div>
        ) : (
          data.map((domain, index) => {
            const isExpanded = expandedDomain === domain.domain;

            return (
              <div key={domain.domain} className="group">
                {/* Desktop Row */}
                <div
                  className={cn(
                    "hidden sm:grid grid-cols-12 gap-3 px-5 py-4 items-center hover:bg-secondary/20 transition-colors cursor-pointer min-w-0",
                    isExpanded && "bg-secondary/10"
                  )}
                  style={{ animationDelay: `${index * 50}ms` }}
                  onClick={() => toggleExpand(domain.domain)}
                >
                  {/* Domain with Favicon */}
                  <div className="col-span-3 flex items-center gap-3 min-w-0">
                    <Favicon domain={domain.domain} size="sm" className="shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium truncate text-sm">
                        {domain.domain || t("unknown")}
                      </p>
                    </div>
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
                  <div className="col-span-1 text-right tabular-nums text-sm">
                    <span className="text-purple-500">{formatBytes(domain.totalUpload)}</span>
                  </div>

                  {/* Connections */}
                  <div className="col-span-1 flex items-center justify-end">
                    <span className="px-2 py-0.5 rounded-full bg-secondary text-xs font-medium">
                      {formatNumber(domain.totalConnections)}
                    </span>
                  </div>

                  {/* Last Seen */}
                  <div className="col-span-1 text-right">
                    <p className="text-xs text-muted-foreground">
                      {formatDuration(domain.lastSeen)}
                    </p>
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
                        toggleExpand(domain.domain);
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
                  onClick={() => toggleExpand(domain.domain)}
                >
                  {/* Row 1: Favicon + Domain (truncate) + IP Count */}
                  <div className="flex items-center gap-2.5 mb-2">
                    <Favicon domain={domain.domain} size="sm" className="shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">
                        {domain.domain || t("unknown")}
                      </p>
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
                        toggleExpand(domain.domain);
                      }}
                    >
                      <Server className="h-3 w-3" />
                      {domain.ips.length}
                      {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </Button>
                  </div>

                  {/* Row 2: Proxy tag - full width, no truncation */}
                  {domain.chains && domain.chains.length > 0 && (
                    <div className="flex items-center gap-1.5 mb-2 pl-[30px]">
                      <ProxyChainBadge chains={domain.chains} truncateLabel={false} />
                    </div>
                  )}

                  {/* Row 3: Traffic stats - compact layout */}
                  <div className="flex items-center gap-3 text-[11px] pl-[30px]">
                    <span className="text-blue-500 tabular-nums">↓ {formatBytes(domain.totalDownload)}</span>
                    <span className="text-purple-500 tabular-nums">↑ {formatBytes(domain.totalUpload)}</span>
                    <span className="text-muted-foreground tabular-nums ml-auto">
                      {formatNumber(domain.totalConnections)} {t("conn")}
                    </span>
                  </div>
                </div>

                {/* Expanded Details: Proxy Traffic + IP List */}
                {isExpanded && (
                  <DomainExpandedDetails
                    domain={domain}
                    proxyStats={proxyStats[domain.domain]}
                    proxyStatsLoading={proxyStatsLoading === domain.domain}
                    ipDetails={ipDetails[domain.domain]}
                    ipDetailsLoading={ipDetailsLoading === domain.domain}
                    labels={{
                      proxyTraffic: t("proxyTraffic"),
                      associatedIPs: t("associatedIPs"),
                      conn: t("conn"),
                    }}
                  />
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Pagination Footer */}
      {totalPages > 0 && (
        <div className="p-3 sm:p-4 border-t border-border/50 bg-secondary/20">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            {/* Page size selector */}
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
                      onClick={() => handlePageSizeChange(size)}
                      className={pageSize === size ? "bg-primary/10" : ""}
                    >
                      {size} / {t("page")}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="text-sm text-muted-foreground">
                {t("total")} {total}
              </span>
            </div>

            {/* Pagination info and controls */}
            <div className="flex items-center gap-2 sm:gap-3">
              <p className="text-xs sm:text-sm text-muted-foreground hidden sm:block">
                {t("showing")} {Math.min((currentPage - 1) * pageSize + 1, total)} - {Math.min(currentPage * pageSize, total)} {t("of")} {total}
              </p>
              <p className="text-xs text-muted-foreground sm:hidden">
                {Math.min((currentPage - 1) * pageSize + 1, total)}-{Math.min(currentPage * pageSize, total)} / {total}
              </p>

              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>

                {getPageNumbers().map((page, idx) => (
                  page === '...' ? (
                    <span key={`ellipsis-${idx}`} className="px-1 sm:px-2 text-muted-foreground text-xs">...</span>
                  ) : (
                    <Button
                      key={page}
                      variant={currentPage === page ? "default" : "ghost"}
                      size="sm"
                      className="h-8 w-8 px-0 text-xs"
                      onClick={() => setCurrentPage(page as number)}
                    >
                      {page}
                    </Button>
                  )
                ))}

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
