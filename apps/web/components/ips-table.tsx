"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  Search,
  ArrowUpDown,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Rows3,
  Globe,
  Server,
  ChevronDown,
  ChevronUp,
  Link2,
  Loader2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CountryFlag } from "@/components/country-flag";
import { formatBytes, formatNumber } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { IPExpandedDetails } from "@/components/stats-tables/expanded-details";
import { ProxyChainBadge } from "@/components/proxy-chain-badge";
import type { DomainStats, IPStats, ProxyTrafficStats } from "@clashmaster/shared";
import { api, type TimeRange } from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface IPsTableProps {
  activeBackendId?: number;
  timeRange?: TimeRange;
}

type SortKey =
  | "ip"
  | "totalDownload"
  | "totalUpload"
  | "totalConnections"
  | "lastSeen";
type SortOrder = "asc" | "desc";

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

// Color palette for IP icons - solid colors that work in both light/dark modes
const IP_COLORS = [
  { bg: "bg-blue-500", text: "text-white" },
  { bg: "bg-violet-500", text: "text-white" },
  { bg: "bg-emerald-500", text: "text-white" },
  { bg: "bg-amber-500", text: "text-white" },
  { bg: "bg-rose-500", text: "text-white" },
  { bg: "bg-cyan-500", text: "text-white" },
  { bg: "bg-indigo-500", text: "text-white" },
  { bg: "bg-teal-500", text: "text-white" },
];

// Get color for IP
const getIPColor = (ip: string) => {
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    hash = ip.charCodeAt(i) + ((hash << 5) - hash);
  }
  return IP_COLORS[Math.abs(hash) % IP_COLORS.length];
};

export function IPsTable({ activeBackendId, timeRange }: IPsTableProps) {
  const t = useTranslations("ips");
  const [data, setData] = useState<IPStats[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("totalDownload");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [expandedIP, setExpandedIP] = useState<string | null>(null);
  const [proxyStats, setProxyStats] = useState<
    Record<string, ProxyTrafficStats[]>
  >({});
  const [proxyStatsLoading, setProxyStatsLoading] = useState<string | null>(
    null,
  );
  const [domainDetails, setDomainDetails] = useState<
    Record<string, DomainStats[]>
  >({});
  const [domainDetailsLoading, setDomainDetailsLoading] = useState<string | null>(
    null,
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search input
  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
      setCurrentPage(1);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  // Fetch data from server
  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      setLoading(true);
      try {
        const result = await api.getIPs(activeBackendId, {
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
        console.error("Failed to fetch IPs:", err);
        if (!cancelled) {
          setData([]);
          setTotal(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchData();
    return () => {
      cancelled = true;
    };
  }, [
    activeBackendId,
    currentPage,
    pageSize,
    sortKey,
    sortOrder,
    debouncedSearch,
    timeRange,
  ]);

  useEffect(() => {
    // Backend switch means a different data universe, collapse safely.
    setExpandedIP(null);
    setProxyStats({});
    setDomainDetails({});
  }, [activeBackendId]);

  // Fetch proxy stats when an IP is expanded
  const fetchProxyStats = useCallback(
    async (ip: string, options?: { force?: boolean; background?: boolean }) => {
      const force = options?.force ?? false;
      const background = options?.background ?? false;
      const hasCached = !!proxyStats[ip];
      if (!force && hasCached) return;
      if (!background || !hasCached) {
        setProxyStatsLoading(ip);
      }
      try {
        const stats = await api.getIPProxyStats(ip, activeBackendId, timeRange);
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
    [proxyStats, activeBackendId, timeRange, proxyStatsLoading],
  );

  // Fetch domain details (with traffic) when an IP is expanded
  const fetchDomainDetails = useCallback(
    async (ip: string, options?: { force?: boolean; background?: boolean }) => {
      const force = options?.force ?? false;
      const background = options?.background ?? false;
      const hasCached = !!domainDetails[ip];
      if (!force && hasCached) return;
      if (!background || !hasCached) {
        setDomainDetailsLoading(ip);
      }
      try {
        const details = await api.getIPDomainDetails(ip, activeBackendId, timeRange);
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
    [domainDetails, activeBackendId, timeRange, domainDetailsLoading],
  );

  useEffect(() => {
    if (!expandedIP) return;
    fetchProxyStats(expandedIP);
    fetchDomainDetails(expandedIP);
  }, [expandedIP, fetchProxyStats, fetchDomainDetails]);

  useEffect(() => {
    if (!expandedIP) return;
    fetchProxyStats(expandedIP, { force: true, background: true });
    fetchDomainDetails(expandedIP, { force: true, background: true });
  }, [timeRange?.start, timeRange?.end, expandedIP, fetchProxyStats, fetchDomainDetails]);

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

  const toggleExpand = (ip: string) => {
    const newExpanded = expandedIP === ip ? null : ip;
    setExpandedIP(newExpanded);
    if (newExpanded) {
      fetchProxyStats(newExpanded);
      fetchDomainDetails(newExpanded);
    }
  };

  const SortIcon = ({ column }: { column: SortKey }) => {
    if (sortKey !== column)
      return <ArrowUpDown className="ml-1 h-3 w-3 text-muted-foreground" />;
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
        pages.push("...");
        pages.push(totalPages);
      } else if (currentPage >= totalPages - 2) {
        pages.push(1);
        pages.push("...");
        for (let i = totalPages - 3; i <= totalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push("...");
        for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i);
        pages.push("...");
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
              {total} {t("ipsCount")}
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

      {/* Desktop Table Header */}
      <div className="hidden sm:grid grid-cols-12 gap-3 px-5 py-3 bg-secondary/30 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        <div
          className="col-span-3 flex items-center cursor-pointer hover:text-foreground transition-colors"
          onClick={() => handleSort("ip")}>
          {t("ipAddress")}
          <SortIcon column="ip" />
        </div>
        <div className="col-span-2 flex items-center">{t("proxy")}</div>
        <div className="col-span-2 flex items-center">{t("location")}</div>
        <div
          className="col-span-2 flex items-center justify-end cursor-pointer hover:text-foreground transition-colors"
          onClick={() => handleSort("totalDownload")}>
          {t("download")}
          <SortIcon column="totalDownload" />
        </div>
        <div
          className="col-span-1 flex items-center justify-end cursor-pointer hover:text-foreground transition-colors"
          onClick={() => handleSort("totalUpload")}>
          {t("upload")}
          <SortIcon column="totalUpload" />
        </div>
        <div
          className="col-span-1 flex items-center justify-end cursor-pointer hover:text-foreground transition-colors"
          onClick={() => handleSort("totalConnections")}>
          {t("conn")}
          <SortIcon column="totalConnections" />
        </div>
        <div className="col-span-1 flex items-center justify-end">
          {t("domainCount")}
        </div>
      </div>

      {/* Mobile Sort Bar */}
      <div className="sm:hidden flex items-center gap-2 px-4 py-2 bg-secondary/30 overflow-x-auto scrollbar-hide">
        {[
          { key: "ip" as SortKey, label: t("ipAddress") },
          { key: "totalDownload" as SortKey, label: t("download") },
          { key: "totalUpload" as SortKey, label: t("upload") },
          { key: "totalConnections" as SortKey, label: t("conn") },
        ].map(({ key, label }) => (
          <button
            key={key}
            className={cn(
              "flex items-center gap-0.5 px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors",
              sortKey === key
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => handleSort(key)}>
            {label}
            {sortKey === key &&
              (sortOrder === "asc" ? (
                <ArrowUp className="h-3 w-3" />
              ) : (
                <ArrowDown className="h-3 w-3" />
              ))}
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
          data.map((ip, index) => {
            const ipColor = getIPColor(ip.ip);
            const isExpanded = expandedIP === ip.ip;

            return (
              <div key={ip.ip} className="group">
                {/* Desktop Row */}
                <div
                  className={cn(
                    "hidden sm:grid grid-cols-12 gap-3 px-5 py-4 items-center hover:bg-secondary/20 transition-colors cursor-pointer min-w-0",
                    isExpanded && "bg-secondary/10",
                  )}
                  style={{ animationDelay: `${index * 50}ms` }}
                  onClick={() => toggleExpand(ip.ip)}>
                  {/* IP with Icon */}
                  <div className="col-span-3 flex items-center gap-3 min-w-0">
                    <div
                      className={`w-5 h-5 rounded-md ${ipColor.bg} ${ipColor.text} flex items-center justify-center shrink-0`}>
                      <Server className="w-3 h-3" />
                    </div>
                    <div className="min-w-0">
                      <code className="text-sm font-medium truncate block">
                        {ip.ip}
                      </code>
                    </div>
                  </div>

                  {/* Proxy */}
                  <div className="col-span-2 flex items-center gap-1.5 min-w-0">
                    <ProxyChainBadge chains={ip.chains} />
                  </div>

                  {/* Location */}
                  <div className="col-span-2 flex items-center min-w-0">
                    {ip.geoIP && ip.geoIP.length > 0 ? (
                      <div className="flex items-center gap-1.5 min-w-0">
                        <CountryFlag country={ip.geoIP[0]} className="h-3.5 w-5" title={ip.geoIP[1] || ip.geoIP[0]} />
                        <span className="text-xs whitespace-nowrap">
                          {ip.geoIP[1] || ip.geoIP[0]}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </div>

                  {/* Download */}
                  <div className="col-span-2 text-right tabular-nums text-sm">
                    <span className="text-blue-500">
                      {formatBytes(ip.totalDownload)}
                    </span>
                  </div>

                  {/* Upload */}
                  <div className="col-span-1 text-right tabular-nums text-sm">
                    <span className="text-purple-500">
                      {formatBytes(ip.totalUpload)}
                    </span>
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
                          : "bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary",
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpand(ip.ip);
                      }}>
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
                    isExpanded && "bg-secondary/10",
                  )}
                  onClick={() => toggleExpand(ip.ip)}>
                  {/* Row 1: IP Icon + IP (truncate) + Domain Count */}
                  <div className="flex items-center gap-2.5 mb-2">
                    <div
                      className={`w-5 h-5 rounded-md ${ipColor.bg} ${ipColor.text} flex items-center justify-center shrink-0`}>
                      <Server className="w-3 h-3" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <code className="text-sm font-medium truncate block">
                        {ip.ip}
                      </code>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-7 px-2 gap-1 text-xs font-medium shrink-0",
                        isExpanded
                          ? "bg-primary/10 text-primary"
                          : "bg-secondary/50 text-muted-foreground",
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpand(ip.ip);
                      }}>
                      <Link2 className="h-3 w-3" />
                      {ip.domains.length}
                      {isExpanded ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                    </Button>
                  </div>

                  {/* Row 2: Location + Proxy tag */}
                  <div className="flex items-center gap-2 mb-2 pl-[30px] flex-wrap">
                    {ip.geoIP && ip.geoIP.length > 0 && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        <CountryFlag country={ip.geoIP[0]} className="h-3.5 w-5" />
                        <span className="truncate">
                          {ip.geoIP[1] || ip.geoIP[0]}
                        </span>
                      </span>
                    )}
                    {ip.chains && ip.chains.length > 0 && (
                      <ProxyChainBadge chains={ip.chains} truncateLabel={false} />
                    )}
                  </div>

                  {/* Row 3: Traffic stats - compact layout */}
                  <div className="flex items-center gap-3 text-[11px] pl-[30px]">
                    <span className="text-blue-500 tabular-nums">
                      ↓ {formatBytes(ip.totalDownload)}
                    </span>
                    <span className="text-purple-500 tabular-nums">
                      ↑ {formatBytes(ip.totalUpload)}
                    </span>
                    <span className="text-muted-foreground tabular-nums ml-auto">
                      {formatNumber(ip.totalConnections)} {t("conn")}
                    </span>
                  </div>
                </div>

                {/* Expanded Details: Proxy Traffic + Domains List */}
                {isExpanded && (
                  <IPExpandedDetails
                    ip={ip}
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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 text-muted-foreground hover:text-foreground">
                    <Rows3 className="h-4 w-4" />
                    <span>
                      {pageSize} / {t("page")}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <DropdownMenuItem
                      key={size}
                      onClick={() => handlePageSizeChange(size)}
                      className={pageSize === size ? "bg-primary/10" : ""}>
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
                {t("showing")}{" "}
                {Math.min((currentPage - 1) * pageSize + 1, total)} -{" "}
                {Math.min(currentPage * pageSize, total)} {t("of")} {total}
              </p>
              <p className="text-xs text-muted-foreground sm:hidden">
                {Math.min((currentPage - 1) * pageSize + 1, total)}-
                {Math.min(currentPage * pageSize, total)} / {total}
              </p>

              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>

                {getPageNumbers().map((page, idx) =>
                  page === "..." ? (
                    <span
                      key={`ellipsis-${idx}`}
                      className="px-1 sm:px-2 text-muted-foreground text-xs">
                      ...
                    </span>
                  ) : (
                    <Button
                      key={page}
                      variant={currentPage === page ? "default" : "ghost"}
                      size="sm"
                      className="h-8 w-8 px-0 text-xs"
                      onClick={() => setCurrentPage(page as number)}>
                      {page}
                    </Button>
                  ),
                )}

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() =>
                    setCurrentPage((p) => Math.min(totalPages, p + 1))
                  }
                  disabled={currentPage === totalPages}>
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
