import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { StatsDatabase } from './db.js';
import { realtimeStore } from './realtime.js';

export class APIServer {
  private app: ReturnType<typeof Fastify> | null = null;
  private db: StatsDatabase;
  private port: number;

  constructor(port: number, db: StatsDatabase) {
    this.port = port;
    this.db = db;
  }

  async start() {
    const app = Fastify({ logger: false });
    this.app = app;

    await app.register(cors, {
      origin: true,
      credentials: true
    });

    // Helper to get backend ID from query or use active backend
    const getBackendId = (request: any): number | null => {
      const { backendId } = request.query as { backendId?: string };
      if (backendId) {
        const id = parseInt(backendId);
        return isNaN(id) ? null : id;
      }
      // If no backendId specified, use the active backend
      const activeBackend = this.db.getActiveBackend();
      return activeBackend?.id ?? null;
    };

    const getTimeRange = (
      request: any,
      reply: any,
    ): { start?: string; end?: string; active: boolean } | null => {
      const { start, end } = request.query as { start?: string; end?: string };
      if (!start && !end) {
        return { active: false };
      }
      if (!start || !end) {
        reply.status(400).send({ error: 'Both start and end must be provided together' });
        return null;
      }

      const startDate = new Date(start);
      const endDate = new Date(end);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        reply.status(400).send({ error: 'Invalid time range format, expected ISO datetime' });
        return null;
      }
      if (startDate > endDate) {
        reply.status(400).send({ error: 'start must be less than or equal to end' });
        return null;
      }

      return {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        active: true,
      };
    };

    const parseLimit = (
      raw: string | undefined,
      fallback: number,
      max: number,
    ): number => {
      if (raw === undefined || raw === null || raw === '') {
        return fallback;
      }
      const parsed = parseInt(raw, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        return fallback;
      }
      return Math.min(parsed, max);
    };

    const shouldIncludeRealtime = (
      timeRange: { start?: string; end?: string; active: boolean },
    ): boolean => {
      if (!timeRange.active) {
        return true;
      }
      if (!timeRange.end) {
        return false;
      }

      const endMs = new Date(timeRange.end).getTime();
      if (Number.isNaN(endMs)) {
        return false;
      }

      // For "latest window" queries (end close to now), keep merging in-memory deltas
      // so dashboard updates stay near real-time between DB flushes.
      const toleranceMs = parseInt(
        process.env.REALTIME_RANGE_END_TOLERANCE_MS || '120000',
        10,
      );
      const windowMs = Number.isFinite(toleranceMs)
        ? Math.max(10_000, toleranceMs)
        : 120_000;
      return endMs >= Date.now() - windowMs;
    };

    // Health check
    app.get('/health', async () => ({ status: 'ok' }));

    // Get summary statistics for a specific backend
    app.get('/api/stats/summary', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);
      
      if (timeRange === null) {
        return;
      }

      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const backend = this.db.getBackend(backendId);
      if (!backend) {
        return reply.status(404).send({ error: 'Backend not found' });
      }

      const includeRealtime = shouldIncludeRealtime(timeRange);
      const summary = this.db.getSummary(
        backendId,
        timeRange.start,
        timeRange.end,
      );
      const summaryWithRealtime = includeRealtime
        ? realtimeStore.applySummaryDelta(backendId, summary)
        : summary;

      const dbTopDomains = this.db.getTopDomains(
        backendId,
        10,
        timeRange.start,
        timeRange.end,
      );
      const topDomains = includeRealtime
        ? realtimeStore.mergeTopDomains(backendId, dbTopDomains, 10)
        : dbTopDomains;

      const dbTopIPs = this.db.getTopIPs(
        backendId,
        10,
        timeRange.start,
        timeRange.end,
      );
      const topIPs = includeRealtime
        ? realtimeStore.mergeTopIPs(backendId, dbTopIPs, 10)
        : dbTopIPs;

      const dbProxyStats = this.db.getProxyStats(
        backendId,
        timeRange.start,
        timeRange.end,
      );
      const proxyStats = includeRealtime
        ? realtimeStore.mergeProxyStats(backendId, dbProxyStats)
        : dbProxyStats;

      const ruleStats = this.db.getRuleStats(
        backendId,
        timeRange.start,
        timeRange.end,
      );
      const hourlyStats = this.db.getHourlyStats(
        backendId,
        24,
        timeRange.start,
        timeRange.end,
      );
      const todayTraffic = this.db.getTrafficInRange(
        backendId,
        timeRange.start,
        timeRange.end,
      );
      const todayDelta = includeRealtime
        ? realtimeStore.getTodayDelta(backendId)
        : { upload: 0, download: 0 };

      return {
        backend: {
          id: backend.id,
          name: backend.name,
          isActive: backend.is_active,
          listening: backend.listening,
        },
        totalConnections: summaryWithRealtime.totalConnections,
        totalUpload: summaryWithRealtime.totalUpload,
        totalDownload: summaryWithRealtime.totalDownload,
        totalDomains: summary.uniqueDomains,
        totalIPs: summary.uniqueIPs,
        totalRules: ruleStats.length,
        totalProxies: proxyStats.length,
        todayUpload: todayTraffic.upload + todayDelta.upload,
        todayDownload: todayTraffic.download + todayDelta.download,
        topDomains,
        topIPs,
        proxyStats,
        ruleStats,
        hourlyStats
      };
    });

    // Get global summary across all backends
    app.get('/api/stats/global', async () => {
      return this.db.getGlobalSummary();
    });

    // Get domain statistics for a specific backend (paginated)
    app.get('/api/stats/domains', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }

      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { offset, limit, sortBy, sortOrder, search } = request.query as {
        offset?: string;
        limit?: string;
        sortBy?: string;
        sortOrder?: string;
        search?: string;
      };
      return this.db.getDomainStatsPaginated(backendId, {
        offset: offset ? parseInt(offset) || 0 : 0,
        limit: limit ? parseInt(limit) || 50 : 50,
        sortBy,
        sortOrder,
        search,
        start: timeRange.start,
        end: timeRange.end,
      });
    });

    // Get IP statistics for a specific backend (paginated)
    app.get('/api/stats/ips', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }

      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { offset, limit, sortBy, sortOrder, search } = request.query as {
        offset?: string;
        limit?: string;
        sortBy?: string;
        sortOrder?: string;
        search?: string;
      };
      return this.db.getIPStatsPaginated(backendId, {
        offset: offset ? parseInt(offset) || 0 : 0,
        limit: limit ? parseInt(limit) || 50 : 50,
        sortBy,
        sortOrder,
        search,
        start: timeRange.start,
        end: timeRange.end,
      });
    });

    // Get per-proxy traffic breakdown for a specific domain
    app.get('/api/stats/domains/proxy-stats', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }
      
      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { domain, sourceIP, sourceChain } = request.query as {
        domain?: string;
        sourceIP?: string;
        sourceChain?: string;
      };
      if (!domain) {
        return reply.status(400).send({ error: 'Domain parameter is required' });
      }

      return this.db.getDomainProxyStats(
        backendId,
        domain,
        timeRange.start,
        timeRange.end,
        sourceIP,
        sourceChain,
      );
    });

    // Get IP details for a specific domain (includes geoIP and traffic)
    app.get('/api/stats/domains/ip-details', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }
      
      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { domain, sourceIP, sourceChain } = request.query as {
        domain?: string;
        sourceIP?: string;
        sourceChain?: string;
      };
      if (!domain) {
        return reply.status(400).send({ error: 'Domain parameter is required' });
      }

      return this.db.getDomainIPDetails(
        backendId,
        domain,
        timeRange.start,
        timeRange.end,
        100,
        sourceIP,
        sourceChain,
      );
    });

    // Get per-proxy traffic breakdown for a specific IP
    app.get('/api/stats/ips/proxy-stats', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }
      
      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { ip, sourceIP, sourceChain } = request.query as {
        ip?: string;
        sourceIP?: string;
        sourceChain?: string;
      };
      if (!ip) {
        return reply.status(400).send({ error: 'IP parameter is required' });
      }

      return this.db.getIPProxyStats(
        backendId,
        ip,
        timeRange.start,
        timeRange.end,
        sourceIP,
        sourceChain,
      );
    });

    // Get domain details for a specific IP (includes traffic and proxy chains)
    app.get('/api/stats/ips/domain-details', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }

      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { ip, sourceIP, sourceChain, limit } = request.query as {
        ip?: string;
        sourceIP?: string;
        sourceChain?: string;
        limit?: string;
      };
      if (!ip) {
        return reply.status(400).send({ error: 'IP parameter is required' });
      }

      const effectiveLimit = parseLimit(limit, 100, 2000);
      return this.db.getIPDomainDetails(
        backendId,
        ip,
        timeRange.start,
        timeRange.end,
        effectiveLimit,
        sourceIP,
        sourceChain,
      );
    });

    // Get domains for a specific proxy/chain
    app.get('/api/stats/proxies/domains', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }
      
      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { chain, limit } = request.query as { chain?: string; limit?: string };
      if (!chain) {
        return reply.status(400).send({ error: 'Chain parameter is required' });
      }
      const effectiveLimit = parseLimit(limit, 5000, 20000);

      return this.db.getProxyDomains(
        backendId,
        chain,
        effectiveLimit,
        timeRange.start,
        timeRange.end,
      );
    });

    // Get IPs for a specific proxy/chain
    app.get('/api/stats/proxies/ips', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }
      
      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { chain, limit } = request.query as { chain?: string; limit?: string };
      if (!chain) {
        return reply.status(400).send({ error: 'Chain parameter is required' });
      }
      const effectiveLimit = parseLimit(limit, 5000, 20000);

      return this.db.getProxyIPs(
        backendId,
        chain,
        effectiveLimit,
        timeRange.start,
        timeRange.end,
      );
    });

    // Get proxy/chain statistics for a specific backend
    app.get('/api/stats/proxies', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);
      
      if (timeRange === null) {
        return;
      }

      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const stats = this.db.getProxyStats(backendId, timeRange.start, timeRange.end);
      if (shouldIncludeRealtime(timeRange)) {
        return realtimeStore.mergeProxyStats(backendId, stats);
      }
      return stats;
    });

    // Get rule statistics for a specific backend
    app.get('/api/stats/rules', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);
      
      if (timeRange === null) {
        return;
      }

      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      return this.db.getRuleStats(backendId, timeRange.start, timeRange.end);
    });

    // Get domains for a specific rule
    app.get('/api/stats/rules/domains', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }
      
      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { rule, limit } = request.query as { rule?: string; limit?: string };
      if (!rule) {
        return reply.status(400).send({ error: 'Rule parameter is required' });
      }
      const effectiveLimit = parseLimit(limit, 5000, 20000);

      return this.db.getRuleDomains(
        backendId,
        rule,
        effectiveLimit,
        timeRange.start,
        timeRange.end,
      );
    });

    // Get IPs for a specific rule
    app.get('/api/stats/rules/ips', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }
      
      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { rule, limit } = request.query as { rule?: string; limit?: string };
      if (!rule) {
        return reply.status(400).send({ error: 'Rule parameter is required' });
      }
      const effectiveLimit = parseLimit(limit, 5000, 20000);

      return this.db.getRuleIPs(
        backendId,
        rule,
        effectiveLimit,
        timeRange.start,
        timeRange.end,
      );
    });

    // Get per-proxy traffic breakdown for a specific domain under a specific rule
    app.get('/api/stats/rules/domains/proxy-stats', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }

      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { rule, domain } = request.query as { rule?: string; domain?: string };
      if (!rule || !domain) {
        return reply.status(400).send({ error: 'Rule and domain parameters are required' });
      }

      return this.db.getRuleDomainProxyStats(
        backendId,
        rule,
        domain,
        timeRange.start,
        timeRange.end,
      );
    });

    // Get IP details for a specific domain under a specific rule
    app.get('/api/stats/rules/domains/ip-details', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }

      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { rule, domain, limit } = request.query as {
        rule?: string;
        domain?: string;
        limit?: string;
      };
      if (!rule || !domain) {
        return reply.status(400).send({ error: 'Rule and domain parameters are required' });
      }
      const effectiveLimit = parseLimit(limit, 100, 2000);

      return this.db.getRuleDomainIPDetails(
        backendId,
        rule,
        domain,
        timeRange.start,
        timeRange.end,
        effectiveLimit,
      );
    });

    // Get per-proxy traffic breakdown for a specific IP under a specific rule
    app.get('/api/stats/rules/ips/proxy-stats', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }

      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { rule, ip } = request.query as { rule?: string; ip?: string };
      if (!rule || !ip) {
        return reply.status(400).send({ error: 'Rule and IP parameters are required' });
      }

      return this.db.getRuleIPProxyStats(
        backendId,
        rule,
        ip,
        timeRange.start,
        timeRange.end,
      );
    });

    // Get domain details for a specific IP under a specific rule
    app.get('/api/stats/rules/ips/domain-details', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }

      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { rule, ip, limit } = request.query as {
        rule?: string;
        ip?: string;
        limit?: string;
      };
      if (!rule || !ip) {
        return reply.status(400).send({ error: 'Rule and IP parameters are required' });
      }
      const effectiveLimit = parseLimit(limit, 100, 2000);

      return this.db.getRuleIPDomainDetails(
        backendId,
        rule,
        ip,
        timeRange.start,
        timeRange.end,
        effectiveLimit,
      );
    });

    // Get rule chain flow for a specific rule
    app.get('/api/stats/rules/chain-flow', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }
      
      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { rule } = request.query as { rule?: string };
      if (!rule) {
        return reply.status(400).send({ error: 'Rule parameter is required' });
      }

      return this.db.getRuleChainFlow(backendId, rule, timeRange.start, timeRange.end);
    });

    // Get all rule chain flows merged into unified DAG
    app.get('/api/stats/rules/chain-flow-all', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);

      if (timeRange === null) {
        return;
      }

      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      return this.db.getAllRuleChainFlows(backendId, timeRange.start, timeRange.end);
    });

    // Get rule to proxy mapping for a specific backend
    app.get('/api/stats/rule-proxy-map', async (request, reply) => {
      const backendId = getBackendId(request);
      
      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      return this.db.getRuleProxyMap(backendId);
    });

    // Get country traffic statistics for a specific backend
    app.get('/api/stats/countries', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);
      
      if (timeRange === null) {
        return;
      }

      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { limit } = request.query as { limit?: string };
      const stats = this.db.getCountryStats(
        backendId,
        parseInt(limit || '50', 10),
        timeRange.start,
        timeRange.end,
      );
      if (shouldIncludeRealtime(timeRange)) {
        return realtimeStore.mergeCountryStats(backendId, stats);
      }
      return stats;
    });

    // Get device statistics for a specific backend
    app.get('/api/stats/devices', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);
      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }
      if (timeRange === null) {
        return;
      }
      const { limit } = request.query as { limit?: string };
      return this.db.getDevices(backendId, parseInt(limit || '50'), timeRange.start, timeRange.end);
    });

    app.get('/api/stats/devices/domains', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);
      if (timeRange === null) {
        return;
      }
      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }
      const { sourceIP, limit } = request.query as { sourceIP: string; limit?: string };
      if (!sourceIP) return [];
      const effectiveLimit = parseLimit(limit, 5000, 20000);
      return this.db.getDeviceDomains(
        backendId,
        sourceIP,
        effectiveLimit,
        timeRange.start,
        timeRange.end,
      );
    });

    app.get('/api/stats/devices/ips', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);
      if (timeRange === null) {
        return;
      }
      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }
      const { sourceIP, limit } = request.query as { sourceIP: string; limit?: string };
      if (!sourceIP) return [];
      const effectiveLimit = parseLimit(limit, 5000, 20000);
      return this.db.getDeviceIPs(
        backendId,
        sourceIP,
        effectiveLimit,
        timeRange.start,
        timeRange.end,
      );
    });

    // Get hourly statistics for a specific backend
    app.get('/api/stats/hourly', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);
      
      if (timeRange === null) {
        return;
      }

      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { hours = 24 } = request.query as { hours?: string };
      return this.db.getHourlyStats(
        backendId,
        parseInt(hours as string) || 24,
        timeRange.start,
        timeRange.end,
      );
    });

    // Get traffic trend for a specific backend (for time range selection)
    app.get('/api/stats/trend', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);
      
      if (timeRange === null) {
        return;
      }

      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { minutes = 30 } = request.query as { minutes?: string };
      const windowMinutes = parseInt(minutes as string) || 30;
      const base = this.db.getTrafficTrend(
        backendId,
        windowMinutes,
        timeRange.start,
        timeRange.end,
      );
      if (!shouldIncludeRealtime(timeRange)) {
        return base;
      }
      return realtimeStore.mergeTrend(backendId, base, windowMinutes, 1);
    });

    // Get traffic trend aggregated by time buckets for chart display
    app.get('/api/stats/trend/aggregated', async (request, reply) => {
      const backendId = getBackendId(request);
      const timeRange = getTimeRange(request, reply);
      
      if (timeRange === null) {
        return;
      }

      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { minutes = 30, bucketMinutes = 1 } = request.query as { minutes?: string; bucketMinutes?: string };
      const windowMinutes = parseInt(minutes as string) || 30;
      const bucket = parseInt(bucketMinutes as string) || 1;
      const base = this.db.getTrafficTrendAggregated(
        backendId,
        windowMinutes,
        bucket,
        timeRange.start,
        timeRange.end,
      );
      if (!shouldIncludeRealtime(timeRange)) {
        return base;
      }
      return realtimeStore.mergeTrend(backendId, base, windowMinutes, bucket);
    });

    // Get recent connections for a specific backend
    app.get('/api/stats/connections', async (request, reply) => {
      const backendId = getBackendId(request);
      
      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }

      const { limit = 100 } = request.query as { limit?: string };
      return this.db.getRecentConnections(backendId, parseInt(limit as string) || 100);
    });

    // Backend management APIs
    // Get all backends
    app.get('/api/backends', async () => {
      const backends = this.db.getAllBackends();
      // Don't return tokens for security
      return backends.map(({ token, ...rest }) => ({ ...rest, hasToken: !!token }));
    });

    // Get active backend
    app.get('/api/backends/active', async () => {
      const backend = this.db.getActiveBackend();
      if (!backend) {
        return { error: 'No active backend configured' };
      }
      // Don't return token for security
      const { token, ...rest } = backend;
      return { ...rest, hasToken: !!token };
    });

    // Get listening backends (all backends currently collecting data)
    app.get('/api/backends/listening', async () => {
      const backends = this.db.getListeningBackends();
      return backends.map(({ token, ...rest }) => ({ ...rest, hasToken: !!token }));
    });

    // Create new backend
    app.post('/api/backends', async (request, reply) => {
      const { name, url, token } = request.body as { name: string; url: string; token?: string };
      
      if (!name || !url) {
        return reply.status(400).send({ error: 'Name and URL are required' });
      }
      
      try {
        // Check if this is the first backend
        const existingBackends = this.db.getAllBackends();
        const isFirstBackend = existingBackends.length === 0;
        
        const id = this.db.createBackend({ name, url, token });
        
        // If this is the first backend, automatically set it as active
        if (isFirstBackend) {
          this.db.setActiveBackend(id);
          console.log(`[API] First backend created, automatically set as active: ${name} (ID: ${id})`);
        }
        
        return { id, isActive: isFirstBackend, message: 'Backend created successfully' };
      } catch (error: any) {
        if (error.message?.includes('UNIQUE constraint failed')) {
          return reply.status(409).send({ error: 'Backend name already exists' });
        }
        throw error;
      }
    });

    // Update backend
    app.put('/api/backends/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const { name, url, token, enabled, listening } = request.body as { 
        name?: string; 
        url?: string; 
        token?: string;
        enabled?: boolean;
        listening?: boolean;
      };
      
      const backendId = parseInt(id);
      const backend = this.db.getBackend(backendId);
      
      if (!backend) {
        return reply.status(404).send({ error: 'Backend not found' });
      }
      
      this.db.updateBackend(backendId, { name, url, token, enabled, listening });
      return { message: 'Backend updated successfully' };
    });

    // Delete backend
    app.delete('/api/backends/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const backendId = parseInt(id);
      
      const backend = this.db.getBackend(backendId);
      if (!backend) {
        return reply.status(404).send({ error: 'Backend not found' });
      }
      
      this.db.deleteBackend(backendId);
      return { message: 'Backend deleted successfully' };
    });

    // Set active backend (for display in UI)
    app.post('/api/backends/:id/activate', async (request, reply) => {
      const { id } = request.params as { id: string };
      const backendId = parseInt(id);
      
      const backend = this.db.getBackend(backendId);
      if (!backend) {
        return reply.status(404).send({ error: 'Backend not found' });
      }
      
      this.db.setActiveBackend(backendId);
      return { message: 'Backend activated successfully' };
    });

    // Set listening state for a backend (controls data collection)
    app.post('/api/backends/:id/listening', async (request, reply) => {
      const { id } = request.params as { id: string };
      const { listening } = request.body as { listening: boolean };
      
      const backendId = parseInt(id);
      const backend = this.db.getBackend(backendId);
      
      if (!backend) {
        return reply.status(404).send({ error: 'Backend not found' });
      }
      
      this.db.setBackendListening(backendId, listening);
      return { message: `Backend ${listening ? 'started' : 'stopped'} listening` };
    });

    // Test existing backend connection (uses stored token)
    app.post('/api/backends/:id/test', async (request, reply) => {
      const { id } = request.params as { id: string };
      const backend = this.db.getBackend(parseInt(id));
      if (!backend) {
        return reply.status(404).send({ error: 'Backend not found' });
      }

      try {
        const wsUrl = backend.url.replace('http://', 'ws://').replace('https://', 'wss://');
        const fullUrl = wsUrl.includes('/connections') ? wsUrl : `${wsUrl}/connections`;

        const headers: Record<string, string> = {};
        if (backend.token) {
          headers['Authorization'] = `Bearer ${backend.token}`;
        }

        const WebSocket = (await import('ws')).default;

        return new Promise((resolve) => {
          const ws = new WebSocket(fullUrl, { headers, timeout: 5000 });

          ws.on('open', () => {
            ws.close();
            resolve({ success: true, message: 'Connection successful' });
          });

          ws.on('error', (error: any) => {
            resolve({ success: false, message: error.message || 'Connection failed' });
          });

          ws.on('close', (code: number) => {
            if (code !== 1000 && code !== 1005) {
              resolve({ success: false, message: `Connection closed with code ${code}` });
            }
          });

          setTimeout(() => {
            ws.terminate();
            resolve({ success: false, message: 'Connection timeout' });
          }, 5000);
        });
      } catch (error: any) {
        return { success: false, message: error.message || 'Connection failed' };
      }
    });

    // Test backend connection
    app.post('/api/backends/test', async (request) => {
      const { url, token } = request.body as { url: string; token?: string };
      
      try {
        const wsUrl = url.replace('http://', 'ws://').replace('https://', 'wss://');
        const fullUrl = wsUrl.includes('/connections') ? wsUrl : `${wsUrl}/connections`;
        
        const headers: Record<string, string> = {};
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        
        // Try to establish WebSocket connection
        const WebSocket = (await import('ws')).default;
        
        return new Promise((resolve) => {
          const ws = new WebSocket(fullUrl, { headers, timeout: 5000 });
          
          ws.on('open', () => {
            ws.close();
            resolve({ success: true, message: 'Connection successful' });
          });
          
          ws.on('error', (error: any) => {
            resolve({ success: false, message: error.message || 'Connection failed' });
          });
          
          ws.on('close', (code: number) => {
            if (code !== 1000 && code !== 1005) {
              resolve({ success: false, message: `Connection closed with code ${code}` });
            }
          });
          
          // Timeout after 5 seconds
          setTimeout(() => {
            ws.terminate();
            resolve({ success: false, message: 'Connection timeout' });
          }, 5000);
        });
      } catch (error: any) {
        return { success: false, message: error.message || 'Connection failed' };
      }
    });

    // Clear all data for a specific backend
    app.post('/api/backends/:id/clear-data', async (request, reply) => {
      const { id } = request.params as { id: string };
      const backendId = parseInt(id);
      
      const backend = this.db.getBackend(backendId);
      if (!backend) {
        return reply.status(404).send({ error: 'Backend not found' });
      }
      
      this.db.deleteBackendData(backendId);
      return { message: 'Backend data cleared successfully' };
    });

    // Clash API proxy endpoints
    // Get providers/proxies from Clash backend
    app.get('/api/clash/providers/proxies', async (request, reply) => {
      const backendId = getBackendId(request);
      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }
      const backend = this.db.getBackend(backendId);
      if (!backend) {
        return reply.status(404).send({ error: 'Backend not found' });
      }

      // Derive Clash REST base URL from the stored WebSocket URL
      const clashBaseUrl = backend.url
        .replace('ws://', 'http://').replace('wss://', 'https://')
        .replace(/\/connections\/?$/, '');

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (backend.token) {
        headers['Authorization'] = `Bearer ${backend.token}`;
      }

      try {
        const res = await fetch(`${clashBaseUrl}/providers/proxies`, { headers });
        if (!res.ok) {
          return reply.status(res.status).send({ error: `Clash API error: ${res.status}` });
        }
        return res.json();
      } catch (err: any) {
        return reply.status(502).send({ error: err.message || 'Failed to reach Clash API' });
      }
    });

    // Get rules from Clash backend
    app.get('/api/clash/rules', async (request, reply) => {
      const backendId = getBackendId(request);
      if (backendId === null) {
        return reply.status(404).send({ error: 'No backend specified or active' });
      }
      const backend = this.db.getBackend(backendId);
      if (!backend) {
        return reply.status(404).send({ error: 'Backend not found' });
      }

      const clashBaseUrl = backend.url
        .replace('ws://', 'http://').replace('wss://', 'https://')
        .replace(/\/connections\/?$/, '');

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (backend.token) {
        headers['Authorization'] = `Bearer ${backend.token}`;
      }

      try {
        const res = await fetch(`${clashBaseUrl}/rules`, { headers });
        if (!res.ok) {
          return reply.status(res.status).send({ error: `Clash API error: ${res.status}` });
        }
        return res.json();
      } catch (err: any) {
        return reply.status(502).send({ error: err.message || 'Failed to reach Clash API' });
      }
    });

    // Database management APIs
    // Get database stats
    app.get('/api/db/stats', async () => {
      return {
        size: this.db.getDatabaseSize(),
        totalConnectionsCount: this.db.getTotalConnectionLogsCount(),
      };
    });

    // Clear old logs (for all backends or specific backend)
    // days=0 means clear all logs
    app.post('/api/db/cleanup', async (request) => {
      const { days, backendId } = request.body as { days: number; backendId?: number };
      
      if (typeof days !== 'number' || days < 0) {
        return { error: 'Valid days parameter required' };
      }

      const result = this.db.cleanupOldData(backendId || null, days);
      
      // Also clear realtime cache when clearing all data
      if (days === 0) {
        if (backendId) {
          // Clear specific backend's cache
          realtimeStore.clearBackend(backendId);
        } else {
          // Clear all backends' cache
          const backends = this.db.getAllBackends();
          for (const backend of backends) {
            realtimeStore.clearBackend(backend.id);
          }
        }
        
        return { 
          message: `Cleaned all data: ${result.deletedConnections} connections, ${result.deletedDomains} domains, ${result.deletedProxies} proxies`,
          deleted: result.deletedConnections,
          domains: result.deletedDomains,
          ips: result.deletedIPs,
          proxies: result.deletedProxies,
          rules: result.deletedRules
        };
      }
      
      return { 
        message: `Cleaned ${result.deletedConnections} old connection logs`,
        deleted: result.deletedConnections
      };
    });

    // Vacuum database
    app.post('/api/db/vacuum', async () => {
      this.db.vacuum();
      return { message: 'Database vacuumed successfully' };
    });

    // Get retention configuration
    app.get('/api/db/retention', async () => {
      return this.db.getRetentionConfig();
    });

    // Update retention configuration
    app.put('/api/db/retention', async (request, reply) => {
      const { connectionLogsDays, hourlyStatsDays, autoCleanup } = request.body as {
        connectionLogsDays?: number;
        hourlyStatsDays?: number;
        autoCleanup?: boolean;
      };

      // Validate input
      if (connectionLogsDays !== undefined && (connectionLogsDays < 1 || connectionLogsDays > 90)) {
        return reply.status(400).send({ error: 'connectionLogsDays must be between 1 and 90' });
      }
      if (hourlyStatsDays !== undefined && (hourlyStatsDays < 7 || hourlyStatsDays > 365)) {
        return reply.status(400).send({ error: 'hourlyStatsDays must be between 7 and 365' });
      }

      const newConfig = this.db.updateRetentionConfig({
        connectionLogsDays,
        hourlyStatsDays,
        autoCleanup,
      });

      return { message: 'Retention configuration updated', config: newConfig };
    });

    await app.listen({ port: this.port, host: '0.0.0.0' });
    console.log(`[API] Server running at http://localhost:${this.port}`);

    return app;
  }

  stop() {
    if (this.app) {
      this.app.close();
      console.log('[API] Server stopped');
    }
  }
}
