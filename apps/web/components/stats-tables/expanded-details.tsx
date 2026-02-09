"use client";

import { Globe, Link2, Loader2, Server, Waypoints } from "lucide-react";
import { CountryFlag } from "@/components/country-flag";
import { Favicon } from "@/components/favicon";
import { getDomainColor, getIPGradient } from "@/lib/stats-utils";
import { formatBytes, formatNumber } from "@/lib/utils";
import type { DomainStats, IPStats, ProxyTrafficStats } from "@clashmaster/shared";

interface DomainExpandedDetailsProps {
  domain: Pick<
    DomainStats,
    "domain" | "ips" | "chains" | "totalDownload" | "totalUpload"
  >;
  richExpand?: boolean;
  proxyStats?: ProxyTrafficStats[];
  proxyStatsLoading?: boolean;
  ipDetails?: IPStats[];
  ipDetailsLoading?: boolean;
  labels: {
    proxyTraffic: string;
    associatedIPs: string;
    conn: string;
  };
  showProxyTraffic?: boolean;
}

interface IPExpandedDetailsProps {
  ip: Pick<
    IPStats,
    "ip" | "domains" | "chains" | "totalDownload" | "totalUpload"
  >;
  richExpand?: boolean;
  proxyStats?: ProxyTrafficStats[];
  proxyStatsLoading?: boolean;
  domainDetails?: DomainStats[];
  domainDetailsLoading?: boolean;
  labels: {
    proxyTraffic: string;
    associatedDomains: string;
    conn: string;
  };
  associatedDomainsIcon?: "link" | "globe";
  showProxyTraffic?: boolean;
}

function getLandingProxy(chain: string): string {
  const parts = chain
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts[0] || chain;
}

function LoadingBlock() {
  return (
    <div className="flex items-center justify-center py-4">
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
    </div>
  );
}

function TrafficBar({
  percent,
  downloadPercent,
  uploadPercent,
}: {
  percent: number;
  downloadPercent: number;
  uploadPercent: number;
}) {
  return (
    <div className="w-full h-1.5 rounded-full bg-secondary/80 mb-1.5 overflow-hidden flex">
      <div
        className="h-full bg-blue-500 transition-all"
        style={{ width: `${Math.max(percent * (downloadPercent / 100), 0.5)}%` }}
      />
      <div
        className="h-full bg-purple-500 transition-all"
        style={{ width: `${Math.max(percent * (uploadPercent / 100), 0.5)}%` }}
      />
    </div>
  );
}

function ProxyFallbackChains({ chains }: { chains: string[] }) {
  if (!chains.length) {
    return <span className="text-xs text-muted-foreground">-</span>;
  }

  const proxies = Array.from(new Set(chains.map(getLandingProxy).filter(Boolean)));

  return (
    <div className="flex flex-wrap gap-1.5">
      {proxies.map((proxy) => (
        <span
          key={proxy}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-secondary/60 text-foreground dark:bg-secondary/40 dark:text-foreground/80 text-xs font-medium max-w-full min-w-0"
          title={proxy}
        >
          <Waypoints className="h-3 w-3 shrink-0" />
          <span className="truncate min-w-0">{proxy}</span>
        </span>
      ))}
    </div>
  );
}

function ProxyTrafficCards({
  proxyStats,
  totalDownload,
  totalUpload,
  connLabel,
}: {
  proxyStats: ProxyTrafficStats[];
  totalDownload: number;
  totalUpload: number;
  connLabel: string;
}) {
  const grouped = new Map<string, ProxyTrafficStats>();
  for (const stat of proxyStats) {
    const proxy = getLandingProxy(stat.chain);
    const prev = grouped.get(proxy);
    if (prev) {
      prev.totalDownload += stat.totalDownload;
      prev.totalUpload += stat.totalUpload;
      prev.totalConnections += stat.totalConnections;
    } else {
      grouped.set(proxy, {
        chain: proxy,
        totalDownload: stat.totalDownload,
        totalUpload: stat.totalUpload,
        totalConnections: stat.totalConnections,
      });
    }
  }
  const mergedStats = Array.from(grouped.values()).sort(
    (a, b) =>
      b.totalDownload + b.totalUpload - (a.totalDownload + a.totalUpload),
  );

  const totalTraffic = totalDownload + totalUpload;
  return (
    <div className="space-y-2">
      {mergedStats.map((ps) => {
        const proxyTraffic = ps.totalDownload + ps.totalUpload;
        const percent = totalTraffic > 0 ? (proxyTraffic / totalTraffic) * 100 : 0;
        const proxyTotal = ps.totalDownload + ps.totalUpload;
        const downloadPercent = proxyTotal > 0 ? (ps.totalDownload / proxyTotal) * 100 : 0;
        const uploadPercent = proxyTotal > 0 ? (ps.totalUpload / proxyTotal) * 100 : 0;

        return (
          <div key={ps.chain} className="px-3 py-2 rounded-lg bg-card border border-border/50">
            <div className="flex items-center justify-between mb-1.5">
              <span
                className="inline-flex items-center gap-1.5 text-xs font-medium truncate max-w-[60%]"
                title={ps.chain}
              >
                <Waypoints className="h-3 w-3 text-orange-500 shrink-0" />
                {ps.chain}
              </span>
              <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                {percent.toFixed(1)}%
              </span>
            </div>
            <TrafficBar
              percent={percent}
              downloadPercent={downloadPercent}
              uploadPercent={uploadPercent}
            />
            <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-[11px] tabular-nums">
              <span className="text-blue-500">↓ {formatBytes(ps.totalDownload)}</span>
              <span className="text-purple-500">↑ {formatBytes(ps.totalUpload)}</span>
              <span className="text-muted-foreground">
                {formatNumber(ps.totalConnections)} {connLabel}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function IPFallbackChips({ ips }: { ips: string[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {ips.map((ip) => {
        const gradient = getIPGradient(ip);
        return (
          <div
            key={ip}
            className="flex items-center gap-2 px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-lg bg-card border border-border/50 hover:border-primary/30 hover:shadow-sm transition-all"
          >
            <div
              className={`w-5 h-5 sm:w-6 sm:h-6 rounded-md bg-gradient-to-br ${gradient} flex items-center justify-center shrink-0`}
            >
              <Server className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-white" />
            </div>
            <code className="text-xs font-mono break-all">{ip}</code>
          </div>
        );
      })}
    </div>
  );
}

function DomainFallbackChips({ domains }: { domains: string[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {domains.map((domain) => {
        const domainColor = getDomainColor(domain);
        return (
          <div
            key={domain}
            className="flex items-center gap-2 px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-lg bg-card border border-border/50 hover:border-primary/30 hover:shadow-sm transition-all"
          >
            <div
              className={`w-5 h-5 sm:w-6 sm:h-6 rounded-md ${domainColor.bg} ${domainColor.text} flex items-center justify-center shrink-0`}
            >
              <Globe className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
            </div>
            <span className="text-xs font-medium truncate max-w-[180px] sm:max-w-[200px]">
              {domain}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function DomainExpandedDetails({
  domain,
  richExpand = true,
  proxyStats = [],
  proxyStatsLoading = false,
  ipDetails = [],
  ipDetailsLoading = false,
  labels,
  showProxyTraffic = true,
}: DomainExpandedDetailsProps) {
  if (!richExpand) {
    return (
      <div className="px-4 sm:px-5 pb-4 bg-secondary/5">
        <div className="pt-3">
          <div className="px-1">
            <p className="text-xs font-medium text-muted-foreground mb-2.5 flex items-center gap-1.5">
              <Globe className="h-3 w-3" />
              {labels.associatedIPs}
            </p>
            <IPFallbackChips ips={domain.ips || []} />
          </div>
        </div>
      </div>
    );
  }

  const totalIPTraffic = ipDetails.reduce((sum, ip) => sum + ip.totalDownload + ip.totalUpload, 0);

  return (
    <div className="px-4 sm:px-5 pb-4 bg-secondary/5">
      <div className={showProxyTraffic ? "pt-3 grid grid-cols-1 sm:grid-cols-2 gap-4" : "pt-3"}>
        {showProxyTraffic && (
          <div className="px-1">
            <p className="text-xs font-medium text-muted-foreground mb-2.5 flex items-center gap-1.5">
              <Waypoints className="h-3 w-3" />
              {labels.proxyTraffic}
            </p>
            {proxyStatsLoading ? (
              <LoadingBlock />
            ) : proxyStats.length > 0 ? (
              <ProxyTrafficCards
                proxyStats={proxyStats}
                totalDownload={domain.totalDownload}
                totalUpload={domain.totalUpload}
                connLabel={labels.conn}
              />
            ) : (
              <ProxyFallbackChains chains={domain.chains || []} />
            )}
          </div>
        )}

        <div className="px-1">
          <p className="text-xs font-medium text-muted-foreground mb-2.5 flex items-center gap-1.5">
            <Globe className="h-3 w-3" />
            {labels.associatedIPs}
          </p>
          {ipDetailsLoading ? (
            <LoadingBlock />
          ) : ipDetails.length > 0 ? (
            <div className="space-y-2">
              {ipDetails.map((ipStat) => {
                const country = ipStat.geoIP?.[0];
                const location =
                  ipStat.geoIP && ipStat.geoIP.length > 1
                    ? ipStat.geoIP[1]
                    : ipStat.geoIP?.[0] || null;
                const ipTraffic = ipStat.totalDownload + ipStat.totalUpload;
                const percent = totalIPTraffic > 0 ? (ipTraffic / totalIPTraffic) * 100 : 0;
                const downloadPercent = ipTraffic > 0 ? (ipStat.totalDownload / ipTraffic) * 100 : 0;
                const uploadPercent = ipTraffic > 0 ? (ipStat.totalUpload / ipTraffic) * 100 : 0;

                return (
                  <div
                    key={ipStat.ip}
                    className="px-3 py-2 rounded-lg bg-card border border-border/50 hover:border-primary/30 hover:shadow-sm transition-all"
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-1.5">
                        <Waypoints className="h-3 w-3 text-orange-500 shrink-0" />
                        <code className="text-xs font-mono">{ipStat.ip}</code>
                      </div>
                      <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                        {percent.toFixed(1)}%
                      </span>
                    </div>
                    <TrafficBar
                      percent={percent}
                      downloadPercent={downloadPercent}
                      uploadPercent={uploadPercent}
                    />
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-0">
                      <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-[11px] tabular-nums">
                        <span className="text-blue-500">↓ {formatBytes(ipStat.totalDownload)}</span>
                        <span className="text-purple-500">↑ {formatBytes(ipStat.totalUpload)}</span>
                        <span className="text-muted-foreground">
                          {formatNumber(ipStat.totalConnections)} {labels.conn}
                        </span>
                      </div>
                      {location && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                          <CountryFlag country={country} className="h-3 w-4" />
                          <span>{location}</span>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <IPFallbackChips ips={domain.ips || []} />
          )}
        </div>
      </div>
    </div>
  );
}

export function IPExpandedDetails({
  ip,
  richExpand = true,
  proxyStats = [],
  proxyStatsLoading = false,
  domainDetails = [],
  domainDetailsLoading = false,
  labels,
  associatedDomainsIcon = "link",
  showProxyTraffic = true,
}: IPExpandedDetailsProps) {
  const AssociatedDomainsTitleIcon = associatedDomainsIcon === "globe" ? Globe : Link2;

  if (!richExpand) {
    return (
      <div className="px-4 sm:px-5 pb-4 bg-secondary/5">
        <div className="pt-3">
          <div className="px-1">
            <p className="text-xs font-medium text-muted-foreground mb-2.5 flex items-center gap-1.5">
              <AssociatedDomainsTitleIcon className="h-3 w-3" />
              {labels.associatedDomains}
            </p>
            <DomainFallbackChips domains={ip.domains || []} />
          </div>
        </div>
      </div>
    );
  }

  const totalDomainTraffic = domainDetails.reduce(
    (sum, domain) => sum + domain.totalDownload + domain.totalUpload,
    0,
  );

  return (
    <div className="px-4 sm:px-5 pb-4 bg-secondary/5">
      <div className={showProxyTraffic ? "pt-3 grid grid-cols-1 sm:grid-cols-2 gap-4" : "pt-3"}>
        {showProxyTraffic && (
          <div className="px-1">
            <p className="text-xs font-medium text-muted-foreground mb-2.5 flex items-center gap-1.5">
              <Waypoints className="h-3 w-3" />
              {labels.proxyTraffic}
            </p>
            {proxyStatsLoading ? (
              <LoadingBlock />
            ) : proxyStats.length > 0 ? (
              <ProxyTrafficCards
                proxyStats={proxyStats}
                totalDownload={ip.totalDownload}
                totalUpload={ip.totalUpload}
                connLabel={labels.conn}
              />
            ) : (
              <ProxyFallbackChains chains={ip.chains || []} />
            )}
          </div>
        )}

        <div className="px-1">
          <p className="text-xs font-medium text-muted-foreground mb-2.5 flex items-center gap-1.5">
            <AssociatedDomainsTitleIcon className="h-3 w-3" />
            {labels.associatedDomains}
          </p>
          {domainDetailsLoading ? (
            <LoadingBlock />
          ) : domainDetails.length > 0 ? (
            <div className="space-y-2">
              {domainDetails.map((domain) => {
                const domainTraffic = domain.totalDownload + domain.totalUpload;
                const percent =
                  totalDomainTraffic > 0 ? (domainTraffic / totalDomainTraffic) * 100 : 0;
                const downloadPercent =
                  domainTraffic > 0 ? (domain.totalDownload / domainTraffic) * 100 : 0;
                const uploadPercent =
                  domainTraffic > 0 ? (domain.totalUpload / domainTraffic) * 100 : 0;

                return (
                  <div
                    key={domain.domain}
                    className="px-3 py-2 rounded-lg bg-card border border-border/50 hover:border-primary/30 hover:shadow-sm transition-all"
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Favicon domain={domain.domain} size="sm" className="shrink-0" />
                        <span className="text-xs font-medium truncate">{domain.domain}</span>
                      </div>
                      <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                        {percent.toFixed(1)}%
                      </span>
                    </div>
                    <TrafficBar
                      percent={percent}
                      downloadPercent={downloadPercent}
                      uploadPercent={uploadPercent}
                    />
                    <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-[11px] tabular-nums">
                      <span className="text-blue-500">↓ {formatBytes(domain.totalDownload)}</span>
                      <span className="text-purple-500">↑ {formatBytes(domain.totalUpload)}</span>
                      <span className="text-muted-foreground">
                        {formatNumber(domain.totalConnections)} {labels.conn}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <DomainFallbackChips domains={ip.domains || []} />
          )}
        </div>
      </div>
    </div>
  );
}
