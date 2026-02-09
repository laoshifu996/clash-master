import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { Connection, DomainStats, IPStats, HourlyStats, DailyStats, ProxyStats, RuleStats, ProxyTrafficStats, DeviceStats } from '@clashmaster/shared';
// Retention config stored in database (doesn't include cleanupInterval)
interface DatabaseRetentionConfig {
  connectionLogsDays: number;
  hourlyStatsDays: number;
  autoCleanup: boolean;
}

export interface TrafficUpdate {
  domain: string;
  ip: string;
  chain: string;
  chains: string[];
  rule: string;
  rulePayload: string;
  upload: number;
  download: number;
  sourceIP?: string;
  timestampMs?: number;
}

export interface BackendConfig {
  id: number;
  name: string;
  url: string;
  token: string;
  enabled: boolean;
  is_active: boolean;
  listening: boolean;
  created_at: string;
  updated_at: string;
}

export class StatsDatabase {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath = 'stats.db') {
    this.dbPath = path.resolve(dbPath);
    this.db = new Database(this.dbPath);
    this.init();
  }

  private init() {
    // Enable WAL mode and performance PRAGMAs for reduced disk IO
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('wal_autocheckpoint = 1000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('cache_size = -16000');     // 16MB page cache
    this.db.pragma('busy_timeout = 5000');

    // Domain statistics - aggregated by domain per backend
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS domain_stats (
        backend_id INTEGER NOT NULL,
        domain TEXT NOT NULL,
        ips TEXT,
        total_upload INTEGER DEFAULT 0,
        total_download INTEGER DEFAULT 0,
        total_connections INTEGER DEFAULT 0,
        last_seen DATETIME,
        rules TEXT,
        chains TEXT,
        PRIMARY KEY (backend_id, domain),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);

    // IP statistics per backend
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ip_stats (
        backend_id INTEGER NOT NULL,
        ip TEXT NOT NULL,
        domains TEXT,
        total_upload INTEGER DEFAULT 0,
        total_download INTEGER DEFAULT 0,
        total_connections INTEGER DEFAULT 0,
        last_seen DATETIME,
        asn TEXT,
        geoip TEXT,
        chains TEXT,
        rules TEXT,
        PRIMARY KEY (backend_id, ip),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);

    // Proxy/Chain statistics per backend
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proxy_stats (
        backend_id INTEGER NOT NULL,
        chain TEXT NOT NULL,
        total_upload INTEGER DEFAULT 0,
        total_download INTEGER DEFAULT 0,
        total_connections INTEGER DEFAULT 0,
        last_seen DATETIME,
        PRIMARY KEY (backend_id, chain),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);

    // Rule statistics per backend
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rule_stats (
        backend_id INTEGER NOT NULL,
        rule TEXT NOT NULL,
        final_proxy TEXT,
        total_upload INTEGER DEFAULT 0,
        total_download INTEGER DEFAULT 0,
        total_connections INTEGER DEFAULT 0,
        last_seen DATETIME,
        PRIMARY KEY (backend_id, rule),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);

    // Rule to proxy mapping per backend
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rule_proxy_map (
        backend_id INTEGER NOT NULL,
        rule TEXT,
        proxy TEXT,
        PRIMARY KEY (backend_id, rule, proxy),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);

    // ASN cache
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS asn_cache (
        ip TEXT PRIMARY KEY,
        asn TEXT,
        org TEXT,
        queried_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // GeoIP cache
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS geoip_cache (
        ip TEXT PRIMARY KEY,
        country TEXT,
        country_name TEXT,
        city TEXT,
        asn TEXT,
        as_name TEXT,
        as_domain TEXT,
        continent TEXT,
        continent_name TEXT,
        queried_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Country traffic statistics per backend
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS country_stats (
        backend_id INTEGER NOT NULL,
        country TEXT NOT NULL,
        country_name TEXT,
        continent TEXT,
        total_upload INTEGER DEFAULT 0,
        total_download INTEGER DEFAULT 0,
        total_connections INTEGER DEFAULT 0,
        last_seen DATETIME,
        PRIMARY KEY (backend_id, country),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);

    // Device statistics per backend
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_stats (
        backend_id INTEGER NOT NULL,
        source_ip TEXT NOT NULL,
        total_upload INTEGER DEFAULT 0,
        total_download INTEGER DEFAULT 0,
        total_connections INTEGER DEFAULT 0,
        last_seen DATETIME,
        PRIMARY KEY (backend_id, source_ip),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);

    // Device×domain traffic aggregation
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_domain_stats (
        backend_id INTEGER NOT NULL,
        source_ip TEXT NOT NULL,
        domain TEXT NOT NULL,
        total_upload INTEGER DEFAULT 0,
        total_download INTEGER DEFAULT 0,
        total_connections INTEGER DEFAULT 0,
        last_seen DATETIME,
        PRIMARY KEY (backend_id, source_ip, domain),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_device_domain_source_ip ON device_domain_stats(backend_id, source_ip);`);

    // Device×IP traffic aggregation
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_ip_stats (
        backend_id INTEGER NOT NULL,
        source_ip TEXT NOT NULL,
        ip TEXT NOT NULL,
        total_upload INTEGER DEFAULT 0,
        total_download INTEGER DEFAULT 0,
        total_connections INTEGER DEFAULT 0,
        last_seen DATETIME,
        PRIMARY KEY (backend_id, source_ip, ip),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_device_ip_source_ip ON device_ip_stats(backend_id, source_ip);`);

    // Hourly aggregation per backend
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hourly_stats (
        backend_id INTEGER NOT NULL,
        hour TEXT NOT NULL,
        upload INTEGER DEFAULT 0,
        download INTEGER DEFAULT 0,
        connections INTEGER DEFAULT 0,
        PRIMARY KEY (backend_id, hour),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);

    // Connection log per backend
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connection_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backend_id INTEGER NOT NULL,
        domain TEXT,
        ip TEXT,
        chain TEXT,
        upload INTEGER DEFAULT 0,
        download INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);

    // Minute-level traffic aggregation (replaces connection_logs for trend queries)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS minute_stats (
        backend_id INTEGER NOT NULL,
        minute TEXT NOT NULL,
        upload INTEGER DEFAULT 0,
        download INTEGER DEFAULT 0,
        connections INTEGER DEFAULT 0,
        PRIMARY KEY (backend_id, minute),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);

    // Minute-level fact table for accurate range queries across domain/ip/rule/proxy/device dimensions
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS minute_dim_stats (
        backend_id INTEGER NOT NULL,
        minute TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        source_ip TEXT NOT NULL DEFAULT '',
        chain TEXT NOT NULL,
        rule TEXT NOT NULL,
        upload INTEGER DEFAULT 0,
        download INTEGER DEFAULT 0,
        connections INTEGER DEFAULT 0,
        PRIMARY KEY (backend_id, minute, domain, ip, source_ip, chain, rule),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);

    // Minute-level country facts for range-based country queries
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS minute_country_stats (
        backend_id INTEGER NOT NULL,
        minute TEXT NOT NULL,
        country TEXT NOT NULL,
        country_name TEXT,
        continent TEXT,
        upload INTEGER DEFAULT 0,
        download INTEGER DEFAULT 0,
        connections INTEGER DEFAULT 0,
        PRIMARY KEY (backend_id, minute, country),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);

    // Domain×proxy traffic aggregation (replaces connection_logs domain+chain GROUP BY)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS domain_proxy_stats (
        backend_id INTEGER NOT NULL,
        domain TEXT NOT NULL,
        chain TEXT NOT NULL,
        total_upload INTEGER DEFAULT 0,
        total_download INTEGER DEFAULT 0,
        total_connections INTEGER DEFAULT 0,
        last_seen DATETIME,
        PRIMARY KEY (backend_id, domain, chain),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_domain_proxy_chain ON domain_proxy_stats(backend_id, chain);`);

    // IP×proxy traffic aggregation (replaces connection_logs ip+chain GROUP BY)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ip_proxy_stats (
        backend_id INTEGER NOT NULL,
        ip TEXT NOT NULL,
        chain TEXT NOT NULL,
        total_upload INTEGER DEFAULT 0,
        total_download INTEGER DEFAULT 0,
        total_connections INTEGER DEFAULT 0,
        last_seen DATETIME,
        domains TEXT,
        PRIMARY KEY (backend_id, ip, chain),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ip_proxy_chain ON ip_proxy_stats(backend_id, chain);`);

    // Rule-specific cross-reference tables for accurate per-rule traffic
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rule_chain_traffic (
        backend_id INTEGER NOT NULL,
        rule TEXT NOT NULL,
        chain TEXT NOT NULL,
        total_upload INTEGER DEFAULT 0,
        total_download INTEGER DEFAULT 0,
        total_connections INTEGER DEFAULT 0,
        last_seen DATETIME,
        PRIMARY KEY (backend_id, rule, chain),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rule_chain_traffic ON rule_chain_traffic(backend_id, rule);`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rule_domain_traffic (
        backend_id INTEGER NOT NULL,
        rule TEXT NOT NULL,
        domain TEXT NOT NULL,
        total_upload INTEGER DEFAULT 0,
        total_download INTEGER DEFAULT 0,
        total_connections INTEGER DEFAULT 0,
        last_seen DATETIME,
        PRIMARY KEY (backend_id, rule, domain),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rule_domain_traffic ON rule_domain_traffic(backend_id, rule);`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rule_ip_traffic (
        backend_id INTEGER NOT NULL,
        rule TEXT NOT NULL,
        ip TEXT NOT NULL,
        total_upload INTEGER DEFAULT 0,
        total_download INTEGER DEFAULT 0,
        total_connections INTEGER DEFAULT 0,
        last_seen DATETIME,
        PRIMARY KEY (backend_id, rule, ip),
        FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rule_ip_traffic ON rule_ip_traffic(backend_id, rule);`);

    // Create indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_domain_stats_backend ON domain_stats(backend_id);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_domain_stats_traffic ON domain_stats(total_download + total_upload);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ip_stats_backend ON ip_stats(backend_id);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ip_stats_traffic ON ip_stats(total_download + total_upload);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_proxy_stats_backend ON proxy_stats(backend_id);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_proxy_stats_traffic ON proxy_stats(total_download + total_upload);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rule_stats_backend ON rule_stats(backend_id);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rule_stats_traffic ON rule_stats(total_download + total_upload);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rule_proxy_map ON rule_proxy_map(backend_id, rule, proxy);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_country_stats_backend ON country_stats(backend_id);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_hourly_stats_backend ON hourly_stats(backend_id);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_minute_stats_backend_minute ON minute_stats(backend_id, minute);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_minute_dim_backend_minute ON minute_dim_stats(backend_id, minute);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_minute_dim_backend_minute_domain ON minute_dim_stats(backend_id, minute, domain);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_minute_dim_backend_minute_ip ON minute_dim_stats(backend_id, minute, ip);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_minute_dim_backend_minute_chain ON minute_dim_stats(backend_id, minute, chain);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_minute_dim_backend_minute_rule ON minute_dim_stats(backend_id, minute, rule);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_minute_dim_backend_minute_source ON minute_dim_stats(backend_id, minute, source_ip);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_minute_country_backend_minute ON minute_country_stats(backend_id, minute);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_connection_logs_backend ON connection_logs(backend_id);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_connection_logs_timestamp ON connection_logs(timestamp);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_connection_logs_domain ON connection_logs(domain);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_connection_logs_chain ON connection_logs(chain);`);

    // Backend configurations - stores OpenClash backend connections
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS backend_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        token TEXT DEFAULT '',
        enabled BOOLEAN DEFAULT 1,
        is_active BOOLEAN DEFAULT 0,
        listening BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create unique index on name
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_configs_name ON backend_configs(name);`);

    // App configuration - stores app-level settings like retention policy
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Insert default retention config if not exists
    this.db.exec(`
      INSERT OR IGNORE INTO app_config (key, value) VALUES 
        ('retention.connection_logs_days', '7'),
        ('retention.hourly_stats_days', '30'),
        ('retention.auto_cleanup', '1');
    `);

    // Migrate existing data if needed (from single-backend schema)
    this.migrateIfNeeded();
  }

  // Migrate from old single-backend schema to multi-backend schema
  private migrateIfNeeded() {
    // Check if we need to migrate by checking if there's data without backend_id
    const needsMigration = this.db.prepare(`
      SELECT 1 FROM sqlite_master 
      WHERE type='table' AND name='domain_stats'
    `).get() as { '1': number } | undefined;

    if (!needsMigration) return;

    // Check if domain_stats table has backend_id column
    const tableInfo = this.db.prepare(`PRAGMA table_info(domain_stats)`).all() as { name: string }[];
    const hasBackendId = tableInfo.some(col => col.name === 'backend_id');

    if (!hasBackendId) {
      console.log('[DB] Migrating from single-backend to multi-backend schema...');
      this.performMigration();
    }

    // Check if backend_configs has listening column
    const backendInfo = this.db.prepare(`PRAGMA table_info(backend_configs)`).all() as { name: string }[];
    const hasListening = backendInfo.some(col => col.name === 'listening');

    if (!hasListening) {
      console.log('[DB] Adding listening column to backend_configs...');
      this.db.exec(`ALTER TABLE backend_configs ADD COLUMN listening BOOLEAN DEFAULT 1;`);
    }

    // Check if ip_stats has chains column (added for proxy display per IP)
    const ipStatsInfo = this.db.prepare(`PRAGMA table_info(ip_stats)`).all() as { name: string }[];
    const hasIPChains = ipStatsInfo.some(col => col.name === 'chains');

    if (!hasIPChains) {
      console.log('[DB] Adding chains column to ip_stats...');
      this.db.exec(`ALTER TABLE ip_stats ADD COLUMN chains TEXT;`);
    }

    // Check if ip_stats has rules column (added for per-rule IP traffic)
    const ipStatsInfo2 = this.db.prepare(`PRAGMA table_info(ip_stats)`).all() as { name: string }[];
    const hasIPRules = ipStatsInfo2.some(col => col.name === 'rules');

    if (!hasIPRules) {
      console.log('[DB] Adding rules column to ip_stats...');
      this.db.exec(`ALTER TABLE ip_stats ADD COLUMN rules TEXT;`);
    }

    // Check if domain_stats has rules column
    const domainStatsInfo = this.db.prepare(`PRAGMA table_info(domain_stats)`).all() as { name: string }[];
    const hasDomainRules = domainStatsInfo.some(col => col.name === 'rules');

    if (!hasDomainRules) {
      console.log('[DB] Adding rules column to domain_stats...');
      this.db.exec(`ALTER TABLE domain_stats ADD COLUMN rules TEXT;`);
    }

    // Check if domain_stats has chains column
    const hasDomainChains = domainStatsInfo.some(col => col.name === 'chains');

    if (!hasDomainChains) {
      console.log('[DB] Adding chains column to domain_stats...');
      this.db.exec(`ALTER TABLE domain_stats ADD COLUMN chains TEXT;`);
    }

    // Migrate connection_logs data to new aggregation tables (one-time backfill)
    this.migrateConnectionLogsToAggregation();
  }

  // Backfill minute_stats, domain_proxy_stats, ip_proxy_stats from connection_logs
  private migrateConnectionLogsToAggregation() {
    // Check if minute_stats is empty and connection_logs has data
    const minuteCount = (this.db.prepare(`SELECT COUNT(*) as c FROM minute_stats`).get() as { c: number }).c;
    const logCount = (this.db.prepare(`SELECT COUNT(*) as c FROM connection_logs`).get() as { c: number }).c;

    if (minuteCount > 0 || logCount === 0) return;

    console.log(`[DB] Migrating ${logCount} connection_logs rows to aggregation tables...`);

    try {
      this.db.exec(`BEGIN TRANSACTION`);

      // Backfill minute_stats
      this.db.exec(`
        INSERT INTO minute_stats (backend_id, minute, upload, download, connections)
        SELECT backend_id,
               strftime('%Y-%m-%dT%H:%M:00', timestamp) as minute,
               SUM(upload), SUM(download), COUNT(*)
        FROM connection_logs
        GROUP BY backend_id, strftime('%Y-%m-%dT%H:%M:00', timestamp)
      `);

      // Backfill domain_proxy_stats
      this.db.exec(`
        INSERT INTO domain_proxy_stats (backend_id, domain, chain, total_upload, total_download, total_connections, last_seen)
        SELECT backend_id, domain, chain,
               SUM(upload), SUM(download), COUNT(*), MAX(timestamp)
        FROM connection_logs
        WHERE domain IS NOT NULL AND domain != 'unknown'
        GROUP BY backend_id, domain, chain
      `);

      // Backfill ip_proxy_stats
      this.db.exec(`
        INSERT INTO ip_proxy_stats (backend_id, ip, chain, total_upload, total_download, total_connections, last_seen, domains)
        SELECT backend_id, ip, chain,
               SUM(upload), SUM(download), COUNT(*), MAX(timestamp),
               GROUP_CONCAT(DISTINCT CASE WHEN domain IS NOT NULL AND domain != 'unknown' THEN domain END)
        FROM connection_logs
        GROUP BY backend_id, ip, chain
      `);

      this.db.exec(`COMMIT`);
      console.log('[DB] Migration to aggregation tables completed successfully');
    } catch (error) {
      this.db.exec(`ROLLBACK`);
      console.error('[DB] Migration to aggregation tables failed:', error);
    }
  }

  private performMigration() {
    // Create temporary tables with new schema and migrate data
    // This is a complex migration - we'll create a default backend and associate all data with it

    this.db.exec(`BEGIN TRANSACTION;`);

    try {
      // Create a default backend if none exists
      const existingBackend = this.db.prepare(`SELECT id FROM backend_configs LIMIT 1`).get() as { id: number } | undefined;
      let defaultBackendId: number;

      if (!existingBackend) {
        const result = this.db.prepare(`
          INSERT INTO backend_configs (name, url, token, enabled, is_active, listening)
          VALUES ('Default', 'http://192.168.1.1:9090', '', 1, 1, 1)
        `).run();
        defaultBackendId = Number(result.lastInsertRowid);
      } else {
        defaultBackendId = existingBackend.id;
      }

      // Migrate domain_stats - recreate table with new schema
      this.db.exec(`
        CREATE TABLE domain_stats_new (
          backend_id INTEGER NOT NULL,
          domain TEXT NOT NULL,
          ips TEXT,
          total_upload INTEGER DEFAULT 0,
          total_download INTEGER DEFAULT 0,
          total_connections INTEGER DEFAULT 0,
          last_seen DATETIME,
          rules TEXT,
          chains TEXT,
          PRIMARY KEY (backend_id, domain),
          FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
        );
      `);
      this.db.exec(`
        INSERT INTO domain_stats_new 
        SELECT ${defaultBackendId} as backend_id, domain, ips, total_upload, total_download, 
               total_connections, last_seen, rules, chains 
        FROM domain_stats;
      `);
      this.db.exec(`DROP TABLE domain_stats;`);
      this.db.exec(`ALTER TABLE domain_stats_new RENAME TO domain_stats;`);

      // Migrate ip_stats
      this.db.exec(`
        CREATE TABLE ip_stats_new (
          backend_id INTEGER NOT NULL,
          ip TEXT NOT NULL,
          domains TEXT,
          total_upload INTEGER DEFAULT 0,
          total_download INTEGER DEFAULT 0,
          total_connections INTEGER DEFAULT 0,
          last_seen DATETIME,
          asn TEXT,
          geoip TEXT,
          chains TEXT,
          rules TEXT,
          PRIMARY KEY (backend_id, ip),
          FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
        );
      `);
      this.db.exec(`
        INSERT INTO ip_stats_new 
        SELECT ${defaultBackendId} as backend_id, ip, domains, total_upload, total_download, 
               total_connections, last_seen, asn, geoip, NULL 
        FROM ip_stats;
      `);
      this.db.exec(`DROP TABLE ip_stats;`);
      this.db.exec(`ALTER TABLE ip_stats_new RENAME TO ip_stats;`);

      // Migrate proxy_stats
      this.db.exec(`
        CREATE TABLE proxy_stats_new (
          backend_id INTEGER NOT NULL,
          chain TEXT NOT NULL,
          total_upload INTEGER DEFAULT 0,
          total_download INTEGER DEFAULT 0,
          total_connections INTEGER DEFAULT 0,
          last_seen DATETIME,
          PRIMARY KEY (backend_id, chain),
          FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
        );
      `);
      this.db.exec(`
        INSERT INTO proxy_stats_new 
        SELECT ${defaultBackendId} as backend_id, chain, total_upload, total_download, 
               total_connections, last_seen 
        FROM proxy_stats;
      `);
      this.db.exec(`DROP TABLE proxy_stats;`);
      this.db.exec(`ALTER TABLE proxy_stats_new RENAME TO proxy_stats;`);

      // Migrate rule_stats
      this.db.exec(`
        CREATE TABLE rule_stats_new (
          backend_id INTEGER NOT NULL,
          rule TEXT NOT NULL,
          final_proxy TEXT,
          total_upload INTEGER DEFAULT 0,
          total_download INTEGER DEFAULT 0,
          total_connections INTEGER DEFAULT 0,
          last_seen DATETIME,
          PRIMARY KEY (backend_id, rule),
          FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
        );
      `);
      this.db.exec(`
        INSERT INTO rule_stats_new 
        SELECT ${defaultBackendId} as backend_id, rule, final_proxy, total_upload, total_download, 
               total_connections, last_seen 
        FROM rule_stats;
      `);
      this.db.exec(`DROP TABLE rule_stats;`);
      this.db.exec(`ALTER TABLE rule_stats_new RENAME TO rule_stats;`);

      // Migrate rule_proxy_map
      this.db.exec(`
        CREATE TABLE rule_proxy_map_new (
          backend_id INTEGER NOT NULL,
          rule TEXT,
          proxy TEXT,
          PRIMARY KEY (backend_id, rule, proxy),
          FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
        );
      `);
      this.db.exec(`
        INSERT INTO rule_proxy_map_new 
        SELECT ${defaultBackendId} as backend_id, rule, proxy 
        FROM rule_proxy_map;
      `);
      this.db.exec(`DROP TABLE rule_proxy_map;`);
      this.db.exec(`ALTER TABLE rule_proxy_map_new RENAME TO rule_proxy_map;`);

      // Migrate country_stats
      this.db.exec(`
        CREATE TABLE country_stats_new (
          backend_id INTEGER NOT NULL,
          country TEXT NOT NULL,
          country_name TEXT,
          continent TEXT,
          total_upload INTEGER DEFAULT 0,
          total_download INTEGER DEFAULT 0,
          total_connections INTEGER DEFAULT 0,
          last_seen DATETIME,
          PRIMARY KEY (backend_id, country),
          FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
        );
      `);
      this.db.exec(`
        INSERT INTO country_stats_new 
        SELECT ${defaultBackendId} as backend_id, country, country_name, continent, total_upload, 
               total_download, total_connections, last_seen 
        FROM country_stats;
      `);
      this.db.exec(`DROP TABLE country_stats;`);
      this.db.exec(`ALTER TABLE country_stats_new RENAME TO country_stats;`);

      // Migrate hourly_stats
      this.db.exec(`
        CREATE TABLE hourly_stats_new (
          backend_id INTEGER NOT NULL,
          hour TEXT NOT NULL,
          upload INTEGER DEFAULT 0,
          download INTEGER DEFAULT 0,
          connections INTEGER DEFAULT 0,
          PRIMARY KEY (backend_id, hour),
          FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
        );
      `);
      this.db.exec(`
        INSERT INTO hourly_stats_new 
        SELECT ${defaultBackendId} as backend_id, hour, upload, download, connections 
        FROM hourly_stats;
      `);
      this.db.exec(`DROP TABLE hourly_stats;`);
      this.db.exec(`ALTER TABLE hourly_stats_new RENAME TO hourly_stats;`);

      // Migrate connection_logs
      this.db.exec(`
        CREATE TABLE connection_logs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          backend_id INTEGER NOT NULL,
          domain TEXT,
          ip TEXT,
          chain TEXT,
          upload INTEGER DEFAULT 0,
          download INTEGER DEFAULT 0,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
        );
      `);
      this.db.exec(`
        INSERT INTO connection_logs_new (id, backend_id, domain, ip, chain, upload, download, timestamp)
        SELECT id, ${defaultBackendId} as backend_id, domain, ip, chain, upload, download, timestamp 
        FROM connection_logs;
      `);
      this.db.exec(`DROP TABLE connection_logs;`);
      this.db.exec(`ALTER TABLE connection_logs_new RENAME TO connection_logs;`);

      this.db.exec(`COMMIT;`);
      console.log('[DB] Migration completed successfully');
    } catch (error) {
      this.db.exec(`ROLLBACK;`);
      console.error('[DB] Migration failed:', error);
      throw error;
    }
  }

  // Update traffic stats with delta values for a specific backend
  updateTrafficStats(backendId: number, update: TrafficUpdate) {
    const now = new Date();
    const timestamp = now.toISOString();
    const hour = timestamp.slice(0, 13) + ':00:00';
    
    // Only process if there's actual traffic
    if (update.upload === 0 && update.download === 0) return;

    // Get rule name from chains (friendly name) or fallback to rule + rulePayload
    const ruleName = update.chains.length > 1 ? update.chains[update.chains.length - 1] : 
                     update.rulePayload ? `${update.rule}(${update.rulePayload})` : update.rule;
    const finalProxy = update.chains.length > 0 ? update.chains[0] : 'DIRECT';
    const fullChain = update.chains.join(' > ') || update.chain || 'DIRECT';

    const transaction = this.db.transaction(() => {
      // Update domain stats with backend_id (skip if domain is unknown)
      const domainName = update.domain || 'unknown';
      if (domainName !== 'unknown') {
        const domainStmt = this.db.prepare(`
          INSERT INTO domain_stats (backend_id, domain, ips, total_upload, total_download, total_connections, last_seen, rules, chains)
          VALUES (@backendId, @domain, @ip, @upload, @download, 1, @timestamp, @rule, @chain)
          ON CONFLICT(backend_id, domain) DO UPDATE SET
            ips = CASE 
              WHEN domain_stats.ips IS NULL THEN @ip
              WHEN INSTR(domain_stats.ips, @ip) > 0 THEN domain_stats.ips
              ELSE domain_stats.ips || ',' || @ip
            END,
            total_upload = total_upload + @upload,
            total_download = total_download + @download,
            total_connections = total_connections + 1,
            last_seen = @timestamp,
            rules = CASE 
              WHEN domain_stats.rules IS NULL THEN @rule
              WHEN INSTR(domain_stats.rules, @rule) > 0 THEN domain_stats.rules
              ELSE domain_stats.rules || ',' || @rule
            END,
            chains = CASE 
              WHEN domain_stats.chains IS NULL THEN @chain
              WHEN INSTR(domain_stats.chains, @chain) > 0 THEN domain_stats.chains
              ELSE domain_stats.chains || ',' || @chain
            END
        `);
        domainStmt.run({
          backendId,
          domain: domainName,
          ip: update.ip,
          upload: update.upload,
          download: update.download,
          timestamp,
          rule: ruleName,
          chain: fullChain
        });
      }

      // Update IP stats with backend_id
      const ipStmt = this.db.prepare(`
        INSERT INTO ip_stats (backend_id, ip, domains, total_upload, total_download, total_connections, last_seen, chains, rules)
        VALUES (@backendId, @ip, @domain, @upload, @download, 1, @timestamp, @chain, @rule)
        ON CONFLICT(backend_id, ip) DO UPDATE SET
          domains = CASE 
            WHEN ip_stats.domains IS NULL THEN @domain
            WHEN INSTR(ip_stats.domains, @domain) > 0 THEN ip_stats.domains
            ELSE ip_stats.domains || ',' || @domain
          END,
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + 1,
          last_seen = @timestamp,
          chains = CASE 
            WHEN ip_stats.chains IS NULL THEN @chain
            WHEN INSTR(ip_stats.chains, @chain) > 0 THEN ip_stats.chains
            ELSE ip_stats.chains || ',' || @chain
          END,
          rules = CASE 
            WHEN ip_stats.rules IS NULL THEN @rule
            WHEN INSTR(ip_stats.rules, @rule) > 0 THEN ip_stats.rules
            ELSE ip_stats.rules || ',' || @rule
          END
      `);
      ipStmt.run({
        backendId,
        ip: update.ip,
        domain: update.domain || 'unknown',
        upload: update.upload,
        download: update.download,
        timestamp,
        chain: fullChain,
        rule: ruleName
      });

      // Update proxy stats with backend_id
      const proxyStmt = this.db.prepare(`
        INSERT INTO proxy_stats (backend_id, chain, total_upload, total_download, total_connections, last_seen)
        VALUES (@backendId, @chain, @upload, @download, 1, @timestamp)
        ON CONFLICT(backend_id, chain) DO UPDATE SET
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + 1,
          last_seen = @timestamp
      `);
      proxyStmt.run({
        backendId,
        chain: fullChain,
        upload: update.upload,
        download: update.download,
        timestamp
      });

      // Update rule stats with backend_id
      const ruleStmt = this.db.prepare(`
        INSERT INTO rule_stats (backend_id, rule, final_proxy, total_upload, total_download, total_connections, last_seen)
        VALUES (@backendId, @rule, @finalProxy, @upload, @download, 1, @timestamp)
        ON CONFLICT(backend_id, rule) DO UPDATE SET
          final_proxy = @finalProxy,
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + 1,
          last_seen = @timestamp
      `);
      ruleStmt.run({
        backendId,
        rule: ruleName,
        finalProxy,
        upload: update.upload,
        download: update.download,
        timestamp
      });

      // Update rule_chain_traffic (all connections have a chain)
      const ruleChainStmt = this.db.prepare(`
        INSERT INTO rule_chain_traffic (backend_id, rule, chain, total_upload, total_download, total_connections, last_seen)
        VALUES (@backendId, @rule, @chain, @upload, @download, 1, @timestamp)
        ON CONFLICT(backend_id, rule, chain) DO UPDATE SET
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + 1,
          last_seen = @timestamp
      `);
      ruleChainStmt.run({
        backendId,
        rule: ruleName,
        chain: fullChain,
        upload: update.upload,
        download: update.download,
        timestamp
      });

      // Update rule_domain_traffic (only when domain is known)
      if (domainName !== 'unknown') {
        const ruleDomainStmt = this.db.prepare(`
          INSERT INTO rule_domain_traffic (backend_id, rule, domain, total_upload, total_download, total_connections, last_seen)
          VALUES (@backendId, @rule, @domain, @upload, @download, 1, @timestamp)
          ON CONFLICT(backend_id, rule, domain) DO UPDATE SET
            total_upload = total_upload + @upload,
            total_download = total_download + @download,
            total_connections = total_connections + 1,
            last_seen = @timestamp
        `);
        ruleDomainStmt.run({
          backendId,
          rule: ruleName,
          domain: domainName,
          upload: update.upload,
          download: update.download,
          timestamp
        });
      }

      // Update rule_ip_traffic (all connections have an IP)
      const ruleIPStmt = this.db.prepare(`
        INSERT INTO rule_ip_traffic (backend_id, rule, ip, total_upload, total_download, total_connections, last_seen)
        VALUES (@backendId, @rule, @ip, @upload, @download, 1, @timestamp)
        ON CONFLICT(backend_id, rule, ip) DO UPDATE SET
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + 1,
          last_seen = @timestamp
      `);
      ruleIPStmt.run({
        backendId,
        rule: ruleName,
        ip: update.ip,
        upload: update.upload,
        download: update.download,
        timestamp
      });

      // Update rule-proxy mapping with backend_id
      if (update.chains.length > 1) {
        const rule = update.chains[update.chains.length - 1];
        const proxy = update.chains[0];
        const ruleProxyStmt = this.db.prepare(`
          INSERT OR IGNORE INTO rule_proxy_map (backend_id, rule, proxy)
          VALUES (@backendId, @rule, @proxy)
        `);
        ruleProxyStmt.run({ backendId, rule, proxy });
      }

      // Update hourly stats with backend_id
      const hourlyStmt = this.db.prepare(`
        INSERT INTO hourly_stats (backend_id, hour, upload, download, connections)
        VALUES (@backendId, @hour, @upload, @download, 1)
        ON CONFLICT(backend_id, hour) DO UPDATE SET
          upload = upload + @upload,
          download = download + @download,
          connections = connections + 1
      `);
      hourlyStmt.run({ backendId, hour, upload: update.upload, download: update.download });

      // UPSERT minute_stats
      const minute = timestamp.slice(0, 16) + ':00'; // 'YYYY-MM-DDTHH:MM:00'
      const minuteStmt = this.db.prepare(`
        INSERT INTO minute_stats (backend_id, minute, upload, download, connections)
        VALUES (@backendId, @minute, @upload, @download, 1)
        ON CONFLICT(backend_id, minute) DO UPDATE SET
          upload = upload + @upload,
          download = download + @download,
          connections = connections + 1
      `);
      minuteStmt.run({ backendId, minute, upload: update.upload, download: update.download });

      // UPSERT domain_proxy_stats (only when domain is known)
      if (domainName !== 'unknown') {
        const domainProxyStmt = this.db.prepare(`
          INSERT INTO domain_proxy_stats (backend_id, domain, chain, total_upload, total_download, total_connections, last_seen)
          VALUES (@backendId, @domain, @chain, @upload, @download, 1, @timestamp)
          ON CONFLICT(backend_id, domain, chain) DO UPDATE SET
            total_upload = total_upload + @upload,
            total_download = total_download + @download,
            total_connections = total_connections + 1,
            last_seen = @timestamp
        `);
        domainProxyStmt.run({
          backendId,
          domain: domainName,
          chain: fullChain,
          upload: update.upload,
          download: update.download,
          timestamp
        });
      }

      // UPSERT ip_proxy_stats
      const ipProxyStmt = this.db.prepare(`
        INSERT INTO ip_proxy_stats (backend_id, ip, chain, total_upload, total_download, total_connections, last_seen, domains)
        VALUES (@backendId, @ip, @chain, @upload, @download, 1, @timestamp, @domain)
        ON CONFLICT(backend_id, ip, chain) DO UPDATE SET
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + 1,
          last_seen = @timestamp,
          domains = CASE
            WHEN ip_proxy_stats.domains IS NULL THEN @domain
            WHEN @domain = 'unknown' THEN ip_proxy_stats.domains
            WHEN INSTR(ip_proxy_stats.domains, @domain) > 0 THEN ip_proxy_stats.domains
            ELSE ip_proxy_stats.domains || ',' || @domain
          END
      `);
      ipProxyStmt.run({
        backendId,
        ip: update.ip,
        chain: fullChain,
        upload: update.upload,
        download: update.download,
        timestamp,
        domain: update.domain || 'unknown'
      });
    });

    transaction();
  }

  // Batch update traffic stats - processes multiple updates in a single transaction
  batchUpdateTrafficStats(backendId: number, updates: TrafficUpdate[]) {
    if (updates.length === 0) return;

    const now = new Date();
    const timestamp = now.toISOString();

    // Aggregate updates by domain, ip, chain to reduce UPSERT conflicts
    const domainMap = new Map<string, TrafficUpdate & { count: number }>();
    const ipMap = new Map<string, TrafficUpdate & { count: number }>();
    const chainMap = new Map<string, { chains: string[]; upload: number; download: number; count: number }>();
    const ruleProxyMap = new Map<string, { rule: string; proxy: string; upload: number; download: number; count: number }>();
    const hourlyMap = new Map<string, { upload: number; download: number; connections: number }>();
    const ruleChainMap = new Map<string, { rule: string; chain: string; upload: number; download: number; count: number }>();
    const ruleDomainMap = new Map<string, { rule: string; domain: string; upload: number; download: number; count: number }>();
    const ruleIPMap = new Map<string, { rule: string; ip: string; upload: number; download: number; count: number }>();
    const minuteMap = new Map<string, { upload: number; download: number; connections: number }>();
    const minuteDimMap = new Map<string, {
      minute: string;
      domain: string;
      ip: string;
      sourceIP: string;
      chain: string;
      rule: string;
      upload: number;
      download: number;
      connections: number;
    }>();
    const domainProxyMap = new Map<string, { domain: string; chain: string; upload: number; download: number; count: number }>();
    const ipProxyMap = new Map<string, { ip: string; chain: string; upload: number; download: number; count: number; domains: Set<string> }>();
    const deviceMap = new Map<string, { sourceIP: string; upload: number; download: number; count: number }>();
    const deviceDomainMap = new Map<string, { sourceIP: string; domain: string; upload: number; download: number; count: number }>();
    const deviceIPMap = new Map<string, { sourceIP: string; ip: string; upload: number; download: number; count: number }>();

    for (const update of updates) {
      if (update.upload === 0 && update.download === 0) continue;

      // Use the last element of chains as the rule name (friendly name from Clash config)
      // e.g., "漏网之鱼", "微软服务", "TikTok"
      const ruleName = update.chains.length > 1 ? update.chains[update.chains.length - 1] : 
                       update.rulePayload ? `${update.rule}(${update.rulePayload})` : update.rule;
      const finalProxy = update.chains.length > 0 ? update.chains[0] : 'DIRECT';
      const fullChain = update.chains.join(' > ') || update.chain || 'DIRECT';
      const eventDate = new Date(update.timestampMs ?? now.getTime());
      const hourKey = this.toHourKey(eventDate);
      const minuteKey = this.toMinuteKey(eventDate);

      // Aggregate domain stats
      if (update.domain) {
        const domainKey = `${update.domain}:${update.ip}:${fullChain}`;
        const existing = domainMap.get(domainKey);
        if (existing) {
          existing.upload += update.upload;
          existing.download += update.download;
          existing.count++;
        } else {
          domainMap.set(domainKey, { ...update, count: 1 });
        }
      }

      // Aggregate IP stats
      const ipKey = `${update.ip}:${update.domain}:${fullChain}`;
      const existingIp = ipMap.get(ipKey);
      if (existingIp) {
        existingIp.upload += update.upload;
        existingIp.download += update.download;
        existingIp.count++;
      } else {
        ipMap.set(ipKey, { ...update, rule: ruleName, count: 1 });
      }

      // Aggregate chain stats
      const chainKey = fullChain;
      const existingChain = chainMap.get(chainKey);
      if (existingChain) {
        existingChain.upload += update.upload;
        existingChain.download += update.download;
        existingChain.count++;
      } else {
        chainMap.set(chainKey, { 
          chains: update.chains, 
          upload: update.upload, 
          download: update.download, 
          count: 1 
        });
      }

      // Aggregate rule stats
      const ruleKey = `${ruleName}:${finalProxy}`;
      const existingRule = ruleProxyMap.get(ruleKey);
      if (existingRule) {
        existingRule.upload += update.upload;
        existingRule.download += update.download;
        existingRule.count++;
      } else {
        ruleProxyMap.set(ruleKey, { rule: ruleName, proxy: finalProxy, upload: update.upload, download: update.download, count: 1 });
      }

      // Aggregate hourly stats
      const existingHour = hourlyMap.get(hourKey);
      if (existingHour) {
        existingHour.upload += update.upload;
        existingHour.download += update.download;
        existingHour.connections++;
      } else {
        hourlyMap.set(hourKey, {
          upload: update.upload,
          download: update.download,
          connections: 1
        });
      }

      // Aggregate rule_chain_traffic
      const fullChainForRule = update.chains.join(' > ');
      const ruleChainKey = `${ruleName}:${fullChainForRule}`;
      const existingRuleChain = ruleChainMap.get(ruleChainKey);
      if (existingRuleChain) {
        existingRuleChain.upload += update.upload;
        existingRuleChain.download += update.download;
        existingRuleChain.count++;
      } else {
        ruleChainMap.set(ruleChainKey, { rule: ruleName, chain: fullChainForRule, upload: update.upload, download: update.download, count: 1 });
      }

      // Aggregate rule_domain_traffic (only when domain exists)
      if (update.domain) {
        const ruleDomainKey = `${ruleName}:${update.domain}`;
        const existingRuleDomain = ruleDomainMap.get(ruleDomainKey);
        if (existingRuleDomain) {
          existingRuleDomain.upload += update.upload;
          existingRuleDomain.download += update.download;
          existingRuleDomain.count++;
        } else {
          ruleDomainMap.set(ruleDomainKey, { rule: ruleName, domain: update.domain, upload: update.upload, download: update.download, count: 1 });
        }
      }

      // Aggregate rule_ip_traffic
      const ruleIPKey = `${ruleName}:${update.ip}`;
      const existingRuleIP = ruleIPMap.get(ruleIPKey);
      if (existingRuleIP) {
        existingRuleIP.upload += update.upload;
        existingRuleIP.download += update.download;
        existingRuleIP.count++;
      } else {
        ruleIPMap.set(ruleIPKey, { rule: ruleName, ip: update.ip, upload: update.upload, download: update.download, count: 1 });
      }

      // Aggregate minute_stats
      const existingMinute = minuteMap.get(minuteKey);
      if (existingMinute) {
        existingMinute.upload += update.upload;
        existingMinute.download += update.download;
        existingMinute.connections++;
      } else {
        minuteMap.set(minuteKey, { upload: update.upload, download: update.download, connections: 1 });
      }

      // Aggregate minute-level dimension facts for range queries
      const dimDomain = update.domain || '';
      const dimIP = update.ip || '';
      const dimSourceIP = update.sourceIP || '';
      const dimChain = fullChain;
      const dimKey = `${minuteKey}:${dimDomain}:${dimIP}:${dimSourceIP}:${dimChain}:${ruleName}`;
      const existingDim = minuteDimMap.get(dimKey);
      if (existingDim) {
        existingDim.upload += update.upload;
        existingDim.download += update.download;
        existingDim.connections++;
      } else {
        minuteDimMap.set(dimKey, {
          minute: minuteKey,
          domain: dimDomain,
          ip: dimIP,
          sourceIP: dimSourceIP,
          chain: dimChain,
          rule: ruleName,
          upload: update.upload,
          download: update.download,
          connections: 1,
        });
      }

      // Aggregate domain_proxy_stats (only when domain exists)
      const proxyChain = fullChain;
      if (update.domain) {
        const dpKey = `${update.domain}:${proxyChain}`;
        const existingDP = domainProxyMap.get(dpKey);
        if (existingDP) {
          existingDP.upload += update.upload;
          existingDP.download += update.download;
          existingDP.count++;
        } else {
          domainProxyMap.set(dpKey, { domain: update.domain, chain: proxyChain, upload: update.upload, download: update.download, count: 1 });
        }
      }

      // Aggregate ip_proxy_stats
      const ipPKey = `${update.ip}:${proxyChain}`;
      const existingIPP = ipProxyMap.get(ipPKey);
      if (existingIPP) {
        existingIPP.upload += update.upload;
        existingIPP.download += update.download;
        existingIPP.count++;
        if (update.domain && update.domain !== 'unknown') {
          existingIPP.domains.add(update.domain);
        }
      } else {
        const domains = new Set<string>();
        if (update.domain && update.domain !== 'unknown') {
          domains.add(update.domain);
        }
        ipProxyMap.set(ipPKey, { ip: update.ip, chain: proxyChain, upload: update.upload, download: update.download, count: 1, domains });
      }

      // Aggregate device stats
      if (update.sourceIP) {
        const sourceIP = update.sourceIP;
        
        // Device stats
        const deviceKey = sourceIP;
        const existingDevice = deviceMap.get(deviceKey);
        if (existingDevice) {
          existingDevice.upload += update.upload;
          existingDevice.download += update.download;
          existingDevice.count++;
        } else {
          deviceMap.set(deviceKey, { sourceIP, upload: update.upload, download: update.download, count: 1 });
        }

        // Device domain stats
        if (update.domain) {
          const deviceDomainKey = `${sourceIP}:${update.domain}`;
          const existingDeviceDomain = deviceDomainMap.get(deviceDomainKey);
          if (existingDeviceDomain) {
            existingDeviceDomain.upload += update.upload;
            existingDeviceDomain.download += update.download;
            existingDeviceDomain.count++;
          } else {
            deviceDomainMap.set(deviceDomainKey, { sourceIP, domain: update.domain, upload: update.upload, download: update.download, count: 1 });
          }
        }

        // Device IP stats
        if (update.ip) {
          const deviceIPKey = `${sourceIP}:${update.ip}`;
          const existingDeviceIP = deviceIPMap.get(deviceIPKey);
          if (existingDeviceIP) {
            existingDeviceIP.upload += update.upload;
            existingDeviceIP.download += update.download;
            existingDeviceIP.count++;
          } else {
            deviceIPMap.set(deviceIPKey, { sourceIP, ip: update.ip, upload: update.upload, download: update.download, count: 1 });
          }
        }
      }
    }

    // Execute batch upserts in a single transaction
    const transaction = this.db.transaction(() => {
      // Domain stats
      const domainStmt = this.db.prepare(`
        INSERT INTO domain_stats (backend_id, domain, ips, total_upload, total_download, total_connections, last_seen, rules, chains)
        VALUES (@backendId, @domain, @ip, @upload, @download, @count, @timestamp, @rule, @chain)
        ON CONFLICT(backend_id, domain) DO UPDATE SET
          ips = CASE 
            WHEN domain_stats.ips IS NULL THEN @ip
            WHEN INSTR(domain_stats.ips, @ip) > 0 THEN domain_stats.ips
            ELSE domain_stats.ips || ',' || @ip
          END,
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + @count,
          last_seen = @timestamp,
          rules = CASE 
            WHEN domain_stats.rules IS NULL THEN @rule
            WHEN INSTR(domain_stats.rules, @rule) > 0 THEN domain_stats.rules
            ELSE domain_stats.rules || ',' || @rule
          END,
          chains = CASE 
            WHEN domain_stats.chains IS NULL THEN @chain
            WHEN INSTR(domain_stats.chains, @chain) > 0 THEN domain_stats.chains
            ELSE domain_stats.chains || ',' || @chain
          END
      `);

      for (const [key, data] of domainMap) {
        const ruleName = data.chains.length > 1 ? data.chains[data.chains.length - 1] : 
                         data.rulePayload ? `${data.rule}(${data.rulePayload})` : data.rule;
        // Store full chain path (joined with > for clarity)
        const fullChain = data.chains.join(' > ');
        domainStmt.run({
          backendId,
          domain: data.domain,
          ip: data.ip,
          upload: data.upload,
          download: data.download,
          count: data.count,
          timestamp,
          rule: ruleName,
          chain: fullChain
        });
      }

      // IP stats
      const ipStmt = this.db.prepare(`
        INSERT INTO ip_stats (backend_id, ip, domains, total_upload, total_download, total_connections, last_seen, chains, rules)
        VALUES (@backendId, @ip, @domain, @upload, @download, @count, @timestamp, @chain, @rule)
        ON CONFLICT(backend_id, ip) DO UPDATE SET
          domains = CASE 
            WHEN ip_stats.domains IS NULL THEN @domain
            WHEN INSTR(ip_stats.domains, @domain) > 0 THEN ip_stats.domains
            ELSE ip_stats.domains || ',' || @domain
          END,
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + @count,
          last_seen = @timestamp,
          chains = CASE 
            WHEN ip_stats.chains IS NULL THEN @chain
            WHEN INSTR(ip_stats.chains, @chain) > 0 THEN ip_stats.chains
            ELSE ip_stats.chains || ',' || @chain
          END,
          rules = CASE 
            WHEN ip_stats.rules IS NULL THEN @rule
            WHEN INSTR(ip_stats.rules, @rule) > 0 THEN ip_stats.rules
            ELSE ip_stats.rules || ',' || @rule
          END
      `);

      for (const [key, data] of ipMap) {
        // Store full chain path (joined with > for clarity)
        const fullChain = data.chains.join(' > ');
        ipStmt.run({
          backendId,
          ip: data.ip,
          domain: data.domain || 'unknown',
          upload: data.upload,
          download: data.download,
          count: data.count,
          timestamp,
          chain: fullChain,
          rule: data.rule
        });
      }

      // Chain/Proxy stats
      const proxyStmt = this.db.prepare(`
        INSERT INTO proxy_stats (backend_id, chain, total_upload, total_download, total_connections, last_seen)
        VALUES (@backendId, @chain, @upload, @download, @count, @timestamp)
        ON CONFLICT(backend_id, chain) DO UPDATE SET
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + @count,
          last_seen = @timestamp
      `);

      for (const [chain, data] of chainMap) {
        proxyStmt.run({
          backendId,
          chain,
          upload: data.upload,
          download: data.download,
          count: data.count,
          timestamp
        });
      }

      // Rule stats
      const ruleStmt = this.db.prepare(`
        INSERT INTO rule_stats (backend_id, rule, final_proxy, total_upload, total_download, total_connections, last_seen)
        VALUES (@backendId, @rule, @proxy, @upload, @download, @count, @timestamp)
        ON CONFLICT(backend_id, rule) DO UPDATE SET
          final_proxy = @proxy,
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + @count,
          last_seen = @timestamp
      `);

      for (const [key, data] of ruleProxyMap) {
        ruleStmt.run({
          backendId,
          rule: data.rule,
          proxy: data.proxy,
          upload: data.upload,
          download: data.download,
          count: data.count,
          timestamp
        });
      }

      // Rule proxy map (only insert, ignore duplicates)
      const ruleProxyStmt = this.db.prepare(`
        INSERT OR IGNORE INTO rule_proxy_map (backend_id, rule, proxy)
        VALUES (@backendId, @rule, @proxy)
      `);

      for (const [key, data] of ruleProxyMap) {
        ruleProxyStmt.run({
          backendId,
          rule: data.rule,
          proxy: data.proxy
        });
      }

      // Hourly stats
      const hourlyStmt = this.db.prepare(`
        INSERT INTO hourly_stats (backend_id, hour, upload, download, connections)
        VALUES (@backendId, @hour, @upload, @download, @connections)
        ON CONFLICT(backend_id, hour) DO UPDATE SET
          upload = upload + @upload,
          download = download + @download,
          connections = connections + @connections
      `);

      for (const [hour, data] of hourlyMap) {
        hourlyStmt.run({
          backendId,
          hour,
          upload: data.upload,
          download: data.download,
          connections: data.connections
        });
      }

      // Rule chain traffic
      const ruleChainStmt = this.db.prepare(`
        INSERT INTO rule_chain_traffic (backend_id, rule, chain, total_upload, total_download, total_connections, last_seen)
        VALUES (@backendId, @rule, @chain, @upload, @download, @count, @timestamp)
        ON CONFLICT(backend_id, rule, chain) DO UPDATE SET
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + @count,
          last_seen = @timestamp
      `);

      for (const [key, data] of ruleChainMap) {
        ruleChainStmt.run({
          backendId,
          rule: data.rule,
          chain: data.chain,
          upload: data.upload,
          download: data.download,
          count: data.count,
          timestamp
        });
      }

      // Rule domain traffic
      const ruleDomainStmt = this.db.prepare(`
        INSERT INTO rule_domain_traffic (backend_id, rule, domain, total_upload, total_download, total_connections, last_seen)
        VALUES (@backendId, @rule, @domain, @upload, @download, @count, @timestamp)
        ON CONFLICT(backend_id, rule, domain) DO UPDATE SET
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + @count,
          last_seen = @timestamp
      `);

      for (const [key, data] of ruleDomainMap) {
        ruleDomainStmt.run({
          backendId,
          rule: data.rule,
          domain: data.domain,
          upload: data.upload,
          download: data.download,
          count: data.count,
          timestamp
        });
      }

      // Rule IP traffic
      const ruleIPStmt = this.db.prepare(`
        INSERT INTO rule_ip_traffic (backend_id, rule, ip, total_upload, total_download, total_connections, last_seen)
        VALUES (@backendId, @rule, @ip, @upload, @download, @count, @timestamp)
        ON CONFLICT(backend_id, rule, ip) DO UPDATE SET
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + @count,
          last_seen = @timestamp
      `);

      for (const [key, data] of ruleIPMap) {
        ruleIPStmt.run({
          backendId,
          rule: data.rule,
          ip: data.ip,
          upload: data.upload,
          download: data.download,
          count: data.count,
          timestamp
        });
      }

      // UPSERT minute_stats
      const minuteStmt = this.db.prepare(`
        INSERT INTO minute_stats (backend_id, minute, upload, download, connections)
        VALUES (@backendId, @minute, @upload, @download, @connections)
        ON CONFLICT(backend_id, minute) DO UPDATE SET
          upload = upload + @upload,
          download = download + @download,
          connections = connections + @connections
      `);

      for (const [minute, data] of minuteMap) {
        minuteStmt.run({
          backendId,
          minute,
          upload: data.upload,
          download: data.download,
          connections: data.connections
        });
      }

      // UPSERT minute_dim_stats (range-query fact table)
      const minuteDimStmt = this.db.prepare(`
        INSERT INTO minute_dim_stats (backend_id, minute, domain, ip, source_ip, chain, rule, upload, download, connections)
        VALUES (@backendId, @minute, @domain, @ip, @sourceIP, @chain, @rule, @upload, @download, @connections)
        ON CONFLICT(backend_id, minute, domain, ip, source_ip, chain, rule) DO UPDATE SET
          upload = upload + @upload,
          download = download + @download,
          connections = connections + @connections
      `);

      for (const [, data] of minuteDimMap) {
        minuteDimStmt.run({
          backendId,
          minute: data.minute,
          domain: data.domain,
          ip: data.ip,
          sourceIP: data.sourceIP,
          chain: data.chain,
          rule: data.rule,
          upload: data.upload,
          download: data.download,
          connections: data.connections,
        });
      }

      // UPSERT domain_proxy_stats
      const domainProxyStmt = this.db.prepare(`
        INSERT INTO domain_proxy_stats (backend_id, domain, chain, total_upload, total_download, total_connections, last_seen)
        VALUES (@backendId, @domain, @chain, @upload, @download, @count, @timestamp)
        ON CONFLICT(backend_id, domain, chain) DO UPDATE SET
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + @count,
          last_seen = @timestamp
      `);

      for (const [key, data] of domainProxyMap) {
        domainProxyStmt.run({
          backendId,
          domain: data.domain,
          chain: data.chain,
          upload: data.upload,
          download: data.download,
          count: data.count,
          timestamp
        });
      }

      // UPSERT ip_proxy_stats (traffic only; domains are updated separately with dedupe)
      const ipProxyStmt = this.db.prepare(`
        INSERT INTO ip_proxy_stats (backend_id, ip, chain, total_upload, total_download, total_connections, last_seen)
        VALUES (@backendId, @ip, @chain, @upload, @download, @count, @timestamp)
        ON CONFLICT(backend_id, ip, chain) DO UPDATE SET
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + @count,
          last_seen = @timestamp
      `);
      const ipProxyDomainStmt = this.db.prepare(`
        UPDATE ip_proxy_stats
        SET domains = CASE
          WHEN domains IS NULL OR domains = '' THEN @domain
          WHEN INSTR(',' || domains || ',', ',' || @domain || ',') > 0 THEN domains
          ELSE domains || ',' || @domain
        END
        WHERE backend_id = @backendId AND ip = @ip AND chain = @chain
      `);

      for (const [key, data] of ipProxyMap) {
        ipProxyStmt.run({
          backendId,
          ip: data.ip,
          chain: data.chain,
          upload: data.upload,
          download: data.download,
          count: data.count,
          timestamp
        });

        if (data.domains.size > 0) {
          for (const domain of data.domains) {
            ipProxyDomainStmt.run({
              backendId,
              ip: data.ip,
              chain: data.chain,
              domain
            });
          }
        }
      }
      // Device stats
      const deviceStmt = this.db.prepare(`
        INSERT INTO device_stats (backend_id, source_ip, total_upload, total_download, total_connections, last_seen)
        VALUES (@backendId, @sourceIP, @upload, @download, @count, @timestamp)
        ON CONFLICT(backend_id, source_ip) DO UPDATE SET
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + @count,
          last_seen = @timestamp
      `);

      for (const [key, data] of deviceMap) {
        deviceStmt.run({
          backendId,
          sourceIP: data.sourceIP,
          upload: data.upload,
          download: data.download,
          count: data.count,
          timestamp
        });
      }

      // Device domain stats
      const deviceDomainStmt = this.db.prepare(`
        INSERT INTO device_domain_stats (backend_id, source_ip, domain, total_upload, total_download, total_connections, last_seen)
        VALUES (@backendId, @sourceIP, @domain, @upload, @download, @count, @timestamp)
        ON CONFLICT(backend_id, source_ip, domain) DO UPDATE SET
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + @count,
          last_seen = @timestamp
      `);

      for (const [key, data] of deviceDomainMap) {
        deviceDomainStmt.run({
          backendId,
          sourceIP: data.sourceIP,
          domain: data.domain,
          upload: data.upload,
          download: data.download,
          count: data.count,
          timestamp
        });
      }

      // Device IP stats
      const deviceIPStmt = this.db.prepare(`
        INSERT INTO device_ip_stats (backend_id, source_ip, ip, total_upload, total_download, total_connections, last_seen)
        VALUES (@backendId, @sourceIP, @ip, @upload, @download, @count, @timestamp)
        ON CONFLICT(backend_id, source_ip, ip) DO UPDATE SET
          total_upload = total_upload + @upload,
          total_download = total_download + @download,
          total_connections = total_connections + @count,
          last_seen = @timestamp
      `);

      for (const [key, data] of deviceIPMap) {
        deviceIPStmt.run({
          backendId,
          sourceIP: data.sourceIP,
          ip: data.ip,
          upload: data.upload,
          download: data.download,
          count: data.count,
          timestamp
        });
      }
    });

    transaction();
  }

  private toMinuteKey(date: Date): string {
    return `${date.toISOString().slice(0, 16)}:00`;
  }

  private toHourKey(date: Date): string {
    return `${date.toISOString().slice(0, 13)}:00:00`;
  }

  private parseMinuteRange(
    start?: string,
    end?: string,
  ): { startMinute: string; endMinute: string } | null {
    if (!start || !end) {
      return null;
    }

    const startDate = new Date(start);
    const endDate = new Date(end);
    if (
      Number.isNaN(startDate.getTime()) ||
      Number.isNaN(endDate.getTime()) ||
      startDate > endDate
    ) {
      return null;
    }

    return {
      startMinute: this.toMinuteKey(startDate),
      endMinute: this.toMinuteKey(endDate),
    };
  }

  private splitChainParts(chain: string): string[] {
    return chain
      .split(">")
      .map((part) => part.trim())
      .filter(Boolean);
  }

  private normalizeFlowLabel(label: string): string {
    return label
      .normalize("NFKC")
      .replace(/^[^\p{L}\p{N}]+/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  private findRuleIndexInChain(chainParts: string[], rule: string): number {
    const exactIndex = chainParts.findIndex((part) => part === rule);
    if (exactIndex !== -1) {
      return exactIndex;
    }

    const normalizedRule = this.normalizeFlowLabel(rule);
    if (!normalizedRule) {
      return -1;
    }

    return chainParts.findIndex(
      (part) => this.normalizeFlowLabel(part) === normalizedRule,
    );
  }

  private getChainFirstHop(chain: string): string {
    const parts = this.splitChainParts(chain);
    return parts[0] || chain;
  }

  private aggregateProxyStatsByFirstHop(rows: ProxyStats[]): ProxyStats[] {
    const merged = new Map<string, ProxyStats>();

    for (const row of rows) {
      const hop = this.getChainFirstHop(row.chain || "") || "DIRECT";
      const existing = merged.get(hop);
      if (existing) {
        existing.totalUpload += row.totalUpload;
        existing.totalDownload += row.totalDownload;
        existing.totalConnections += row.totalConnections;
        if (row.lastSeen > existing.lastSeen) {
          existing.lastSeen = row.lastSeen;
        }
      } else {
        merged.set(hop, {
          chain: hop,
          totalUpload: row.totalUpload,
          totalDownload: row.totalDownload,
          totalConnections: row.totalConnections,
          lastSeen: row.lastSeen,
        });
      }
    }

    return Array.from(merged.values()).sort(
      (a, b) => (b.totalDownload + b.totalUpload) - (a.totalDownload + a.totalUpload),
    );
  }

  private allocateByWeights(total: number, weights: number[]): number[] {
    if (weights.length === 0) return [];
    const sum = weights.reduce((acc, w) => acc + w, 0);
    if (sum <= 0) {
      const base = Math.floor(total / weights.length);
      const result = new Array(weights.length).fill(base);
      let remainder = total - base * weights.length;
      for (let i = 0; i < result.length && remainder > 0; i++, remainder--) {
        result[i] += 1;
      }
      return result;
    }

    const raw = weights.map(w => (total * w) / sum);
    const floored = raw.map(v => Math.floor(v));
    let remainder = total - floored.reduce((acc, v) => acc + v, 0);
    const order = raw
      .map((v, i) => ({ i, frac: v - Math.floor(v) }))
      .sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
      floored[order[k].i] += 1;
    }
    return floored;
  }

  /**
   * minute_dim_stats stores proxy hop in `chain` (e.g. DIRECT), which loses
   * middle nodes. For ranged chain-flow queries we remap range traffic onto
   * full chains from cumulative rule_chain_traffic to preserve topology.
   */
  private remapRangeRowsToFullChains(
    rangeRows: Array<{
      rule: string;
      chain: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
    }>,
    baselineRows: Array<{
      rule: string;
      chain: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
    }>,
  ): Array<{
    rule: string;
    chain: string;
    totalUpload: number;
    totalDownload: number;
    totalConnections: number;
  }> {
    if (rangeRows.length === 0) return [];
    if (baselineRows.length === 0) return rangeRows;

    const baselineByRuleHop = new Map<string, typeof baselineRows>();
    const baselineByNormalizedRuleHop = new Map<string, typeof baselineRows>();
    for (const row of baselineRows) {
      const hop = this.getChainFirstHop(row.chain);
      const key = `${row.rule}|||${hop}`;
      const list = baselineByRuleHop.get(key);
      if (list) {
        list.push(row);
      } else {
        baselineByRuleHop.set(key, [row]);
      }

      const normalizedRule = this.normalizeFlowLabel(row.rule);
      if (!normalizedRule) continue;
      const normalizedKey = `${normalizedRule}|||${hop}`;
      const normalizedList = baselineByNormalizedRuleHop.get(normalizedKey);
      if (normalizedList) {
        normalizedList.push(row);
      } else {
        baselineByNormalizedRuleHop.set(normalizedKey, [row]);
      }
    }

    const mapped: Array<{
      rule: string;
      chain: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
    }> = [];

    for (const row of rangeRows) {
      const parts = this.splitChainParts(row.chain);
      const alreadyFull =
        parts.length > 1 && this.findRuleIndexInChain(parts, row.rule) !== -1;
      if (alreadyFull) {
        mapped.push(row);
        continue;
      }

      const hop = this.getChainFirstHop(row.chain);
      const normalizedRule = this.normalizeFlowLabel(row.rule);
      const candidates =
        baselineByRuleHop.get(`${row.rule}|||${hop}`) ||
        (normalizedRule
          ? baselineByNormalizedRuleHop.get(`${normalizedRule}|||${hop}`)
          : undefined);
      if (!candidates || candidates.length === 0) {
        mapped.push(row);
        continue;
      }

      if (candidates.length === 1) {
        mapped.push({
          rule: row.rule,
          chain: candidates[0].chain,
          totalUpload: row.totalUpload,
          totalDownload: row.totalDownload,
          totalConnections: row.totalConnections,
        });
        continue;
      }

      const weights = candidates.map(c => {
        const traffic = c.totalUpload + c.totalDownload;
        return traffic > 0 ? traffic : Math.max(1, c.totalConnections);
      });
      const uploadParts = this.allocateByWeights(row.totalUpload, weights);
      const downloadParts = this.allocateByWeights(row.totalDownload, weights);
      const connParts = this.allocateByWeights(row.totalConnections, weights);
      for (let i = 0; i < candidates.length; i++) {
        mapped.push({
          rule: row.rule,
          chain: candidates[i].chain,
          totalUpload: uploadParts[i] || 0,
          totalDownload: downloadParts[i] || 0,
          totalConnections: connParts[i] || 0,
        });
      }
    }

    return mapped;
  }

  /**
   * Build a normalized rule flow path in "rule -> ... -> proxy" order.
   * Legacy cumulative rows often store full chain ending with rule, while
   * minute_dim rows may only store proxy/group chain without rule.
   */
  private buildRuleFlowPath(rule: string, chain: string): string[] {
    const chainParts = this.splitChainParts(chain);
    if (chainParts.length === 0) {
      return [];
    }

    const ruleIndex = this.findRuleIndexInChain(chainParts, rule);
    if (ruleIndex !== -1) {
      // Full chain stored as proxy > ... > rule, reverse to rule > ... > proxy.
      return chainParts.slice(0, ruleIndex + 1).reverse();
    }

    // Fallback for mismatched labels or minute_dim rows:
    // normalize direction to rule/group -> ... -> proxy.
    const reversed = [...chainParts].reverse();
    const normalizedRule = this.normalizeFlowLabel(rule);
    const normalizedHead = this.normalizeFlowLabel(reversed[0] || "");
    if (normalizedRule && normalizedRule === normalizedHead) {
      return reversed;
    }

    return [rule, ...reversed];
  }

  private uniqueNonEmpty(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of values) {
      const v = (raw || "").trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  }

  /**
   * Some range queries aggregate from minute_dim_stats where historical rows may
   * only contain the final proxy hop in `chain`. This method expands those
   * short hops to full chains using rule_chain_traffic when possible.
   */
  private expandShortChainsForRules(
    backendId: number,
    chains: string[],
    rules: string[],
  ): string[] {
    const normalizedChains = this.uniqueNonEmpty(chains);
    if (normalizedChains.length === 0) return [];

    const shortChains = normalizedChains.filter((c) => !c.includes(">"));
    if (shortChains.length === 0) return normalizedChains;

    const normalizedRules = this.uniqueNonEmpty(rules);
    const whereParts: string[] = [];
    const params: Array<string | number> = [backendId];

    if (normalizedRules.length > 0) {
      const rulePlaceholders = normalizedRules.map(() => "?").join(", ");
      whereParts.push(`rule IN (${rulePlaceholders})`);
      params.push(...normalizedRules);
    }

    const chainMatchers: string[] = [];
    for (const chain of shortChains) {
      chainMatchers.push("(chain = ? OR chain LIKE ?)");
      params.push(chain, `${chain} > %`);
    }
    whereParts.push(`(${chainMatchers.join(" OR ")})`);

    const whereClause = whereParts.length > 0 ? `AND ${whereParts.join(" AND ")}` : "";
    const stmt = this.db.prepare(`
      SELECT DISTINCT chain
      FROM rule_chain_traffic
      WHERE backend_id = ? ${whereClause}
      LIMIT 500
    `);

    const rows = stmt.all(...params) as Array<{ chain: string }>;
    const expanded = this.uniqueNonEmpty(rows.map((r) => r.chain));

    if (expanded.length === 0) {
      return normalizedChains;
    }

    // Prefer expanded full chains, but keep already-full values from input too.
    const fullInputChains = normalizedChains.filter((c) => c.includes(">"));
    return this.uniqueNonEmpty([...expanded, ...fullInputChains]);
  }

  // Get a specific domain by name
  getDomainByName(backendId: number, domain: string): DomainStats | null {
    const stmt = this.db.prepare(`
      SELECT domain, total_upload as totalUpload, total_download as totalDownload, 
             total_connections as totalConnections, last_seen as lastSeen, ips, rules, chains
      FROM domain_stats
      WHERE backend_id = ? AND domain = ?
    `);
    const row = stmt.get(backendId, domain) as {
      domain: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
      lastSeen: string;
      ips: string;
      rules: string | null;
      chains: string | null;
    } | undefined;
    
    if (!row) return null;
    
    return {
      ...row,
      ips: row.ips ? row.ips.split(',') : [],
      rules: row.rules ? row.rules.split(',') : [],
      chains: row.chains ? row.chains.split(',') : [],
    } as DomainStats;
  }

  // Get all domain stats for a specific backend
  getDomainStats(backendId: number, limit = 100, start?: string, end?: string): DomainStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          domain,
          SUM(upload) as totalUpload,
          SUM(download) as totalDownload,
          SUM(connections) as totalConnections,
          MAX(minute) as lastSeen,
          GROUP_CONCAT(DISTINCT ip) as ips,
          GROUP_CONCAT(DISTINCT rule) as rules,
          GROUP_CONCAT(DISTINCT chain) as chains
        FROM minute_dim_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ? AND domain != ''
        GROUP BY domain
        ORDER BY (SUM(upload) + SUM(download)) DESC
        LIMIT ?
      `);
      const rows = stmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
        limit,
      ) as Array<{
        domain: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
        lastSeen: string;
        ips: string | null;
        rules: string | null;
        chains: string | null;
      }>;

      return rows.map(row => {
        const rules = row.rules ? row.rules.split(',').filter(Boolean) : [];
        const chains = row.chains ? row.chains.split(',').filter(Boolean) : [];
        return {
          ...row,
          ips: row.ips ? row.ips.split(',').filter(Boolean) : [],
          rules,
          chains: this.expandShortChainsForRules(backendId, chains, rules),
        };
      }) as DomainStats[];
    }

    const stmt = this.db.prepare(`
      SELECT domain, total_upload as totalUpload, total_download as totalDownload, 
             total_connections as totalConnections, last_seen as lastSeen, ips, rules, chains
      FROM domain_stats
      WHERE backend_id = ?
      ORDER BY (total_upload + total_download) DESC
      LIMIT ?
    `);
    const rows = stmt.all(backendId, limit) as Array<{
      domain: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
      lastSeen: string;
      ips: string | null;
      rules: string | null;
      chains: string | null;
    }>;
    
    return rows.map(row => {
      const rules = row.rules ? row.rules.split(',').filter(Boolean) : [];
      const chains = row.chains ? row.chains.split(',').filter(Boolean) : [];
      return {
        ...row,
        ips: row.ips ? row.ips.split(',') : [],
        rules,
        chains: this.expandShortChainsForRules(backendId, chains, rules),
      };
    }) as DomainStats[];
  }

  // Get IP stats for specific IPs (used for domain IP details)
  getIPStatsByIPs(backendId: number, ips: string[]): IPStats[] {
    const filteredIps = ips.filter(ip => ip && ip.trim() !== '');
    if (filteredIps.length === 0) return [];
    
    const placeholders = filteredIps.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT 
        i.ip, 
        i.domains, 
        i.total_upload as totalUpload, 
        i.total_download as totalDownload, 
        i.total_connections as totalConnections, 
        i.last_seen as lastSeen,
        COALESCE(i.asn, g.asn) as asn,
        CASE 
          WHEN g.country IS NOT NULL THEN 
            json_array(
              g.country,
              COALESCE(g.country_name, g.country),
              COALESCE(g.city, ''),
              COALESCE(g.as_name, '')
            )
          WHEN i.geoip IS NOT NULL THEN 
            json(i.geoip)
          ELSE 
            NULL
        END as geoIP,
        i.chains
      FROM ip_stats i
      LEFT JOIN geoip_cache g ON i.ip = g.ip
      WHERE i.backend_id = ? AND i.ip IN (${placeholders})
      ORDER BY (i.total_upload + i.total_download) DESC
    `);
    const rows = stmt.all(backendId, ...filteredIps) as Array<{
      ip: string;
      domains: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
      lastSeen: string;
      asn: string | null;
      geoIP: string | null;
      chains: string | null;
    }>;
    
    return rows.map(row => ({
      ...row,
      domains: row.domains ? row.domains.split(',') : [],
      geoIP: row.geoIP ? JSON.parse(row.geoIP).filter(Boolean) : undefined,
      asn: row.asn || undefined,
      chains: row.chains ? row.chains.split(',') : [],
    })) as IPStats[];
  }

  // Get IP details for a specific domain (supports optional time range)
  getDomainIPDetails(
    backendId: number,
    domain: string,
    start?: string,
    end?: string,
    limit = 100,
    sourceIP?: string,
    sourceChain?: string,
  ): IPStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range || sourceIP || sourceChain) {
      const conditions = ["m.backend_id = ?", "m.domain = ?", "m.ip != ''"];
      const params: Array<string | number> = [backendId, domain];
      if (range) {
        conditions.push("m.minute >= ?", "m.minute <= ?");
        params.push(range.startMinute, range.endMinute);
      }
      if (sourceIP) {
        conditions.push("m.source_ip = ?");
        params.push(sourceIP);
      }
      if (sourceChain) {
        conditions.push("(m.chain = ? OR m.chain LIKE ?)");
        params.push(sourceChain, `${sourceChain} > %`);
      }

      const stmt = this.db.prepare(`
        SELECT
          m.ip,
          GROUP_CONCAT(DISTINCT CASE WHEN m.domain != '' THEN m.domain END) as domains,
          SUM(m.upload) as totalUpload,
          SUM(m.download) as totalDownload,
          SUM(m.connections) as totalConnections,
          MAX(m.minute) as lastSeen,
          COALESCE(i.asn, g.asn) as asn,
          CASE
            WHEN g.country IS NOT NULL THEN
              json_array(
                g.country,
                COALESCE(g.country_name, g.country),
                COALESCE(g.city, ''),
                COALESCE(g.as_name, '')
              )
            WHEN i.geoip IS NOT NULL THEN
              json(i.geoip)
            ELSE
              NULL
	          END as geoIP,
	          GROUP_CONCAT(DISTINCT m.chain) as chains,
          GROUP_CONCAT(DISTINCT m.rule) as rules
	        FROM minute_dim_stats m
        LEFT JOIN ip_stats i ON m.backend_id = i.backend_id AND m.ip = i.ip
        LEFT JOIN geoip_cache g ON m.ip = g.ip
        WHERE ${conditions.join(" AND ")}
        GROUP BY m.ip
        ORDER BY (SUM(m.upload) + SUM(m.download)) DESC
        LIMIT ?
      `);
      const rows = stmt.all(...params, limit) as Array<{
        ip: string;
        domains: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
        lastSeen: string;
	        asn: string | null;
	        geoIP: string | null;
	        chains: string | null;
          rules: string | null;
	      }>;

	      return rows.map(row => {
          const rules = row.rules ? row.rules.split(',').filter(Boolean) : [];
          const chains = row.chains ? row.chains.split(',').filter(Boolean) : [];
          return {
            ...row,
            domains: row.domains ? row.domains.split(',').filter(Boolean) : [],
            geoIP: row.geoIP ? JSON.parse(row.geoIP).filter(Boolean) : undefined,
            asn: row.asn || undefined,
            chains: this.expandShortChainsForRules(backendId, chains, rules),
          };
        }) as IPStats[];
	    }

    const domainData = this.getDomainByName(backendId, domain);
    if (!domainData || !domainData.ips || domainData.ips.length === 0) {
      return [];
    }
    return this.getIPStatsByIPs(backendId, domainData.ips.slice(0, limit));
  }

  // Get domain details for a specific IP (supports optional time range and sourceIP filter)
  getIPDomainDetails(
    backendId: number,
    ip: string,
    start?: string,
    end?: string,
    limit = 100,
    sourceIP?: string,
    sourceChain?: string,
  ): DomainStats[] {
    const range = this.parseMinuteRange(start, end);
    const conditions = ["backend_id = ?", "ip = ?", "domain != ''"];
    const params: Array<string | number> = [backendId, ip];

    if (range) {
      conditions.push("minute >= ?", "minute <= ?");
      params.push(range.startMinute, range.endMinute);
    }
    if (sourceIP) {
      conditions.push("source_ip = ?");
      params.push(sourceIP);
    }
    if (sourceChain) {
      conditions.push("(chain = ? OR chain LIKE ?)");
      params.push(sourceChain, `${sourceChain} > %`);
    }

    const stmt = this.db.prepare(`
      SELECT
        domain,
        GROUP_CONCAT(DISTINCT ip) as ips,
        SUM(upload) as totalUpload,
        SUM(download) as totalDownload,
        SUM(connections) as totalConnections,
        MAX(minute) as lastSeen,
        GROUP_CONCAT(DISTINCT CASE WHEN rule != '' THEN rule END) as rules,
        GROUP_CONCAT(DISTINCT chain) as chains
      FROM minute_dim_stats
      WHERE ${conditions.join(" AND ")}
      GROUP BY domain
      ORDER BY (SUM(upload) + SUM(download)) DESC
      LIMIT ?
    `);

    const rows = stmt.all(...params, limit) as Array<{
      domain: string;
      ips: string | null;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
      lastSeen: string;
      rules: string | null;
      chains: string | null;
    }>;

    return rows.map(row => {
      const rules = row.rules ? row.rules.split(',').filter(Boolean) : [];
      const chains = row.chains ? row.chains.split(',').filter(Boolean) : [];
      return {
        domain: row.domain,
        ips: row.ips ? row.ips.split(',').filter(Boolean) : [],
        totalUpload: row.totalUpload,
        totalDownload: row.totalDownload,
        totalConnections: row.totalConnections,
        lastSeen: row.lastSeen,
        rules,
        chains: this.expandShortChainsForRules(backendId, chains, rules),
      };
    }) as DomainStats[];
  }

  // Get all IP stats for a specific backend
  getIPStats(backendId: number, limit = 100, start?: string, end?: string): IPStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          m.ip,
          GROUP_CONCAT(DISTINCT CASE WHEN m.domain != '' THEN m.domain END) as domains,
          SUM(m.upload) as totalUpload,
          SUM(m.download) as totalDownload,
          SUM(m.connections) as totalConnections,
          MAX(m.minute) as lastSeen,
          COALESCE(i.asn, g.asn) as asn,
          CASE
            WHEN g.country IS NOT NULL THEN
              json_array(
                g.country,
                COALESCE(g.country_name, g.country),
                COALESCE(g.city, ''),
                COALESCE(g.as_name, '')
              )
            WHEN i.geoip IS NOT NULL THEN
              json(i.geoip)
            ELSE
              NULL
	          END as geoIP,
	          GROUP_CONCAT(DISTINCT m.chain) as chains,
          GROUP_CONCAT(DISTINCT m.rule) as rules
	        FROM minute_dim_stats m
        LEFT JOIN ip_stats i ON m.backend_id = i.backend_id AND m.ip = i.ip
        LEFT JOIN geoip_cache g ON m.ip = g.ip
        WHERE m.backend_id = ? AND m.minute >= ? AND m.minute <= ? AND m.ip != ''
        GROUP BY m.ip
        ORDER BY (SUM(m.upload) + SUM(m.download)) DESC
        LIMIT ?
      `);
      const rows = stmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
        limit,
      ) as Array<{
        ip: string;
        domains: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
        lastSeen: string;
	        asn: string | null;
	        geoIP: string | null;
	        chains: string | null;
          rules: string | null;
	      }>;

	      return rows.map(row => {
          const rules = row.rules ? row.rules.split(',').filter(Boolean) : [];
          const chains = row.chains ? row.chains.split(',').filter(Boolean) : [];
          return {
            ...row,
            domains: row.domains ? row.domains.split(',').filter(Boolean) : [],
            geoIP: row.geoIP ? JSON.parse(row.geoIP).filter(Boolean) : undefined,
            asn: row.asn || undefined,
            chains: this.expandShortChainsForRules(backendId, chains, rules),
          };
        }) as IPStats[];
	    }

    const stmt = this.db.prepare(`
      SELECT 
        i.ip, 
        i.domains, 
        i.total_upload as totalUpload, 
        i.total_download as totalDownload, 
        i.total_connections as totalConnections, 
        i.last_seen as lastSeen,
        COALESCE(i.asn, g.asn) as asn,
        CASE 
          WHEN g.country IS NOT NULL THEN 
            json_array(
              g.country,
              COALESCE(g.country_name, g.country),
              COALESCE(g.city, ''),
              COALESCE(g.as_name, '')
            )
          WHEN i.geoip IS NOT NULL THEN 
            json(i.geoip)
          ELSE 
            NULL
        END as geoIP,
        i.chains
      FROM ip_stats i
      LEFT JOIN geoip_cache g ON i.ip = g.ip
      WHERE i.backend_id = ? AND i.ip != ''
      ORDER BY (i.total_upload + i.total_download) DESC
      LIMIT ?
    `);
    const rows = stmt.all(backendId, limit) as Array<{
      ip: string;
      domains: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
      lastSeen: string;
      asn: string | null;
      geoIP: string | null;
      chains: string | null;
    }>;
    
    return rows.map(row => ({
      ...row,
      domains: row.domains ? row.domains.split(',') : [],
      geoIP: row.geoIP ? JSON.parse(row.geoIP).filter(Boolean) : undefined,
      asn: row.asn || undefined,
      chains: row.chains ? row.chains.split(',') : [],
    })) as IPStats[];
  }

  // Get hourly stats for a specific backend
  getHourlyStats(backendId: number, hours = 24, start?: string, end?: string): HourlyStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          substr(minute, 1, 13) || ':00:00' as hour,
          SUM(upload) as upload,
          SUM(download) as download,
          SUM(connections) as connections
        FROM minute_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ?
        GROUP BY substr(minute, 1, 13)
        ORDER BY hour DESC
        LIMIT ?
      `);
      return stmt.all(backendId, range.startMinute, range.endMinute, hours) as HourlyStats[];
    }

    const stmt = this.db.prepare(`
      SELECT hour, upload, download, connections
      FROM hourly_stats
      WHERE backend_id = ?
      ORDER BY hour DESC
      LIMIT ?
    `);
    return stmt.all(backendId, hours) as HourlyStats[];
  }

  // Get today's traffic for a specific backend
  getTodayTraffic(backendId: number): { upload: number; download: number } {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const stmt = this.db.prepare(`
      SELECT COALESCE(SUM(upload), 0) as upload, COALESCE(SUM(download), 0) as download
      FROM hourly_stats
      WHERE backend_id = ? AND hour >= ?
    `);
    return stmt.get(backendId, today) as { upload: number; download: number };
  }

  getTrafficInRange(
    backendId: number,
    start?: string,
    end?: string,
  ): { upload: number; download: number } {
    const range = this.parseMinuteRange(start, end);
    if (!range) {
      return this.getTodayTraffic(backendId);
    }

    const stmt = this.db.prepare(`
      SELECT
        COALESCE(SUM(upload), 0) as upload,
        COALESCE(SUM(download), 0) as download
      FROM minute_stats
      WHERE backend_id = ? AND minute >= ? AND minute <= ?
    `);
    return stmt.get(
      backendId,
      range.startMinute,
      range.endMinute,
    ) as { upload: number; download: number };
  }

  // Get traffic trend for a specific backend (for time range selection)
  getTrafficTrend(
    backendId: number,
    minutes = 30,
    start?: string,
    end?: string,
  ): Array<{ time: string; upload: number; download: number }> {
    const range = this.parseMinuteRange(start, end);
    const cutoff = new Date(Date.now() - minutes * 60 * 1000);
    const cutoffStr = cutoff.toISOString().slice(0, 16) + ':00';
    const stmt = this.db.prepare(`
      SELECT minute as time, upload, download
      FROM minute_stats
      WHERE backend_id = ? AND minute >= ? AND minute <= ?
      ORDER BY minute ASC
    `);
    return stmt.all(
      backendId,
      range?.startMinute || cutoffStr,
      range?.endMinute || this.toMinuteKey(new Date()),
    ) as Array<{ time: string; upload: number; download: number }>;
  }

  // Get traffic trend aggregated by time buckets for chart display
  getTrafficTrendAggregated(
    backendId: number,
    minutes = 30,
    bucketMinutes = 1,
    start?: string,
    end?: string,
  ): Array<{ time: string; upload: number; download: number }> {
    const range = this.parseMinuteRange(start, end);
    const cutoff = new Date(Date.now() - minutes * 60 * 1000);
    const cutoffStr = cutoff.toISOString().slice(0, 16) + ':00';
    const endMinute = range?.endMinute || this.toMinuteKey(new Date());

    if (bucketMinutes <= 1) {
      // Direct query - each row is already 1-minute granularity
      const stmt = this.db.prepare(`
        SELECT minute as time, upload, download
        FROM minute_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ?
        ORDER BY minute ASC
      `);
      return stmt.all(
        backendId,
        range?.startMinute || cutoffStr,
        endMinute,
      ) as Array<{ time: string; upload: number; download: number }>;
    }

    // Aggregate multiple minutes into larger buckets
    const bucketExpr = `strftime('%Y-%m-%dT%H:%M:00', datetime((strftime('%s', datetime(minute)) / ${bucketMinutes * 60}) * ${bucketMinutes * 60}, 'unixepoch'))`;
    const stmt = this.db.prepare(`
      SELECT
        ${bucketExpr} as time,
        SUM(upload) as upload,
        SUM(download) as download
      FROM minute_stats
      WHERE backend_id = ? AND minute >= ? AND minute <= ?
      GROUP BY ${bucketExpr}
      ORDER BY time ASC
    `);
    return stmt.all(
      backendId,
      range?.startMinute || cutoffStr,
      endMinute,
    ) as Array<{ time: string; upload: number; download: number }>;
  }

  // Get country stats for a specific backend
  getCountryStats(
    backendId: number,
    limit = 50,
    start?: string,
    end?: string,
  ): Array<{ country: string; countryName: string; continent: string; totalUpload: number; totalDownload: number; totalConnections: number }> {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const minuteCountryStmt = this.db.prepare(`
        SELECT
          country,
          MAX(country_name) as countryName,
          MAX(continent) as continent,
          SUM(upload) as totalUpload,
          SUM(download) as totalDownload,
          SUM(connections) as totalConnections
        FROM minute_country_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ?
        GROUP BY country
        ORDER BY (SUM(upload) + SUM(download)) DESC
        LIMIT ?
      `);
      const minuteCountryRows = minuteCountryStmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
        limit,
      ) as Array<{ country: string; countryName: string; continent: string; totalUpload: number; totalDownload: number; totalConnections: number }>;
      if (minuteCountryRows.length > 0) {
        return minuteCountryRows;
      }

      // Fallback 1: derive country distribution from minute_dim_stats + geoip_cache
      // This covers periods where minute_country_stats is missing but dimension facts exist.
      const minuteDimFallbackStmt = this.db.prepare(`
        SELECT
          COALESCE(g.country, 'UNKNOWN') as country,
          COALESCE(MAX(g.country_name), 'Unknown') as countryName,
          COALESCE(MAX(g.continent), 'Unknown') as continent,
          SUM(m.upload) as totalUpload,
          SUM(m.download) as totalDownload,
          SUM(m.connections) as totalConnections
        FROM minute_dim_stats m
        LEFT JOIN geoip_cache g ON m.ip = g.ip
        WHERE m.backend_id = ? AND m.minute >= ? AND m.minute <= ? AND m.ip != ''
        GROUP BY COALESCE(g.country, 'UNKNOWN')
        ORDER BY (SUM(m.upload) + SUM(m.download)) DESC
        LIMIT ?
      `);
      const minuteDimFallbackRows = minuteDimFallbackStmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
        limit,
      ) as Array<{ country: string; countryName: string; continent: string; totalUpload: number; totalDownload: number; totalConnections: number }>;
      if (minuteDimFallbackRows.length > 0) {
        return minuteDimFallbackRows;
      }

      // Fallback 2: if only minute_stats exists for this range, keep totals visible as UNKNOWN country.
      const totalStmt = this.db.prepare(`
        SELECT
          COALESCE(SUM(upload), 0) as upload,
          COALESCE(SUM(download), 0) as download,
          COALESCE(SUM(connections), 0) as connections
        FROM minute_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ?
      `);
      const total = totalStmt.get(
        backendId,
        range.startMinute,
        range.endMinute,
      ) as { upload: number; download: number; connections: number };
      if (total.upload > 0 || total.download > 0 || total.connections > 0) {
        return [{
          country: 'UNKNOWN',
          countryName: 'Unknown',
          continent: 'Unknown',
          totalUpload: total.upload,
          totalDownload: total.download,
          totalConnections: total.connections,
        }];
      }

      return [];
    }

    const stmt = this.db.prepare(`
      SELECT country, country_name as countryName, continent, 
             total_upload as totalUpload, total_download as totalDownload, 
             total_connections as totalConnections
      FROM country_stats
      WHERE backend_id = ?
      ORDER BY (total_upload + total_download) DESC
      LIMIT ?
    `);
    return stmt.all(backendId, limit) as Array<{ country: string; countryName: string; continent: string; totalUpload: number; totalDownload: number; totalConnections: number }>;
  }

  // Update country stats for a specific backend
  updateCountryStats(backendId: number, country: string, countryName: string, continent: string, upload: number, download: number) {
    const stmt = this.db.prepare(`
      INSERT INTO country_stats (backend_id, country, country_name, continent, total_upload, total_download, total_connections, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(backend_id, country) DO UPDATE SET
        total_upload = total_upload + ?,
        total_download = total_download + ?,
        total_connections = total_connections + 1,
        last_seen = CURRENT_TIMESTAMP
    `);
    stmt.run(backendId, country, countryName, continent, upload, download, upload, download);
  }

  // Batch update country stats - wraps all upserts in a single transaction
  batchUpdateCountryStats(backendId: number, results: Array<{
    country: string; countryName: string; continent: string;
    upload: number; download: number;
    timestampMs?: number;
  }>): void {
    if (results.length === 0) return;

    const cumulativeStmt = this.db.prepare(`
      INSERT INTO country_stats (backend_id, country, country_name, continent, total_upload, total_download, total_connections, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(backend_id, country) DO UPDATE SET
        total_upload = total_upload + ?,
        total_download = total_download + ?,
        total_connections = total_connections + 1,
        last_seen = CURRENT_TIMESTAMP
    `);

    const minuteStmt = this.db.prepare(`
      INSERT INTO minute_country_stats (backend_id, minute, country, country_name, continent, upload, download, connections)
      VALUES (@backendId, @minute, @country, @countryName, @continent, @upload, @download, @connections)
      ON CONFLICT(backend_id, minute, country) DO UPDATE SET
        upload = upload + @upload,
        download = download + @download,
        connections = connections + @connections
    `);

    const tx = this.db.transaction(() => {
      const minuteMap = new Map<string, {
        minute: string;
        country: string;
        countryName: string;
        continent: string;
        upload: number;
        download: number;
        connections: number;
      }>();

      for (const r of results) {
        cumulativeStmt.run(backendId, r.country, r.countryName, r.continent, r.upload, r.download, r.upload, r.download);

        const minute = this.toMinuteKey(new Date(r.timestampMs ?? Date.now()));
        const key = `${minute}:${r.country}`;
        const existing = minuteMap.get(key);
        if (existing) {
          existing.upload += r.upload;
          existing.download += r.download;
          existing.connections++;
        } else {
          minuteMap.set(key, {
            minute,
            country: r.country,
            countryName: r.countryName,
            continent: r.continent,
            upload: r.upload,
            download: r.download,
            connections: 1,
          });
        }
      }

      for (const [, item] of minuteMap) {
        minuteStmt.run({
          backendId,
          minute: item.minute,
          country: item.country,
          countryName: item.countryName,
          continent: item.continent,
          upload: item.upload,
          download: item.download,
          connections: item.connections,
        });
      }
    });
    tx();
  }

  // Get device stats for a specific backend
  getDevices(backendId: number, limit = 50, start?: string, end?: string): DeviceStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          source_ip as sourceIP,
          SUM(upload) as totalUpload,
          SUM(download) as totalDownload,
          SUM(connections) as totalConnections,
          MAX(minute) as lastSeen
        FROM minute_dim_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ? AND source_ip != ''
        GROUP BY source_ip
        ORDER BY (SUM(upload) + SUM(download)) DESC
        LIMIT ?
      `);
      return stmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
        limit,
      ) as DeviceStats[];
    }

    const stmt = this.db.prepare(`
      SELECT source_ip as sourceIP,
             total_upload as totalUpload, total_download as totalDownload, 
             total_connections as totalConnections, last_seen as lastSeen
      FROM device_stats
      WHERE backend_id = ?
      ORDER BY (total_upload + total_download) DESC
      LIMIT ?
    `);
    return stmt.all(backendId, limit) as DeviceStats[];
  }

  // Get domain breakdown for a specific device
  getDeviceDomains(
    backendId: number,
    sourceIP: string,
    limit = 5000,
    start?: string,
    end?: string,
  ): DomainStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          domain,
          SUM(upload) as totalUpload,
          SUM(download) as totalDownload,
          SUM(connections) as totalConnections,
          MAX(minute) as lastSeen,
          GROUP_CONCAT(DISTINCT ip) as ips,
          GROUP_CONCAT(DISTINCT rule) as rules,
          GROUP_CONCAT(DISTINCT chain) as chains
        FROM minute_dim_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ? AND source_ip = ? AND domain != ''
        GROUP BY domain
        ORDER BY (SUM(upload) + SUM(download)) DESC
        LIMIT ?
      `);
      const rows = stmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
        sourceIP,
        limit,
      ) as Array<{
        domain: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
        lastSeen: string;
        ips: string | null;
        rules: string | null;
        chains: string | null;
      }>;
      return rows.map(row => {
        const rules = row.rules ? row.rules.split(',').filter(Boolean) : [];
        const chains = row.chains ? row.chains.split(',').filter(Boolean) : [];
        return {
          ...row,
          ips: row.ips ? row.ips.split(',').filter(Boolean) : [],
          rules,
          chains: this.expandShortChainsForRules(backendId, chains, rules),
        };
      }) as DomainStats[];
    }

    const stmt = this.db.prepare(`
      SELECT 
        d.domain, 
        d.total_upload as totalUpload, 
        d.total_download as totalDownload, 
        d.total_connections as totalConnections, 
        d.last_seen as lastSeen,
        g.ips
      FROM device_domain_stats d
      LEFT JOIN domain_stats g ON d.domain = g.domain AND d.backend_id = g.backend_id
      WHERE d.backend_id = ? AND d.source_ip = ?
      ORDER BY (d.total_upload + d.total_download) DESC
      LIMIT ?
    `);
    const result = stmt.all(backendId, sourceIP, limit) as any[];
    return result.map(r => ({
      ...r,
      ips: r.ips ? r.ips.split(',') : [],
      rules: [],
      chains: []
    }));
  }

  // Get IP breakdown for a specific device
  getDeviceIPs(
    backendId: number,
    sourceIP: string,
    limit = 5000,
    start?: string,
    end?: string,
  ): IPStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          m.ip,
          SUM(m.upload) as totalUpload,
          SUM(m.download) as totalDownload,
          SUM(m.connections) as totalConnections,
          MAX(m.minute) as lastSeen,
          GROUP_CONCAT(DISTINCT CASE WHEN m.domain != '' THEN m.domain END) as domains,
          COALESCE(i.asn, g.asn) as asn,
          CASE
            WHEN g.country IS NOT NULL THEN
              json_array(
                g.country,
                COALESCE(g.country_name, g.country),
                COALESCE(g.city, ''),
                COALESCE(g.as_name, '')
              )
            WHEN i.geoip IS NOT NULL THEN
              json(i.geoip)
            ELSE
              NULL
          END as geoIP,
	          GROUP_CONCAT(DISTINCT m.chain) as chains,
          GROUP_CONCAT(DISTINCT m.rule) as rules
        FROM minute_dim_stats m
        LEFT JOIN ip_stats i ON m.backend_id = i.backend_id AND m.ip = i.ip
        LEFT JOIN geoip_cache g ON m.ip = g.ip
        WHERE m.backend_id = ? AND m.minute >= ? AND m.minute <= ? AND m.source_ip = ? AND m.ip != ''
        GROUP BY m.ip
        ORDER BY (SUM(m.upload) + SUM(m.download)) DESC
        LIMIT ?
      `);
      const rows = stmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
        sourceIP,
        limit,
      ) as Array<{
        ip: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
        lastSeen: string;
	        domains: string | null;
	        asn: string | null;
	        geoIP: string | null;
	        chains: string | null;
          rules: string | null;
	      }>;
	      return rows.map(row => {
          const rules = row.rules ? row.rules.split(',').filter(Boolean) : [];
          const chains = row.chains ? row.chains.split(',').filter(Boolean) : [];
          return {
            ...row,
            domains: row.domains ? row.domains.split(',').filter(Boolean) : [],
            geoIP: row.geoIP ? JSON.parse(row.geoIP).filter(Boolean) : undefined,
            asn: row.asn || undefined,
            chains: this.expandShortChainsForRules(backendId, chains, rules),
          };
        }) as IPStats[];
	    }

    const stmt = this.db.prepare(`
      SELECT 
        d.ip, 
        d.total_upload as totalUpload, 
        d.total_download as totalDownload, 
        d.total_connections as totalConnections, 
        d.last_seen as lastSeen,
        i.domains,
        COALESCE(i.asn, g.asn) as asn,
        CASE 
          WHEN g.country IS NOT NULL THEN 
            json_array(
              g.country,
              COALESCE(g.country_name, g.country),
              COALESCE(g.city, ''),
              COALESCE(g.as_name, '')
            )
          WHEN i.geoip IS NOT NULL THEN 
            json(i.geoip)
          ELSE 
            NULL
        END as geoIP
      FROM device_ip_stats d
      LEFT JOIN ip_stats i ON d.ip = i.ip AND d.backend_id = i.backend_id
      LEFT JOIN geoip_cache g ON d.ip = g.ip
      WHERE d.backend_id = ? AND d.source_ip = ?
      ORDER BY (d.total_upload + d.total_download) DESC
      LIMIT ?
    `);
    const result = stmt.all(backendId, sourceIP, limit) as any[];
    return result.map(r => ({
      ...r,
      domains: r.domains ? r.domains.split(',') : [],
      geoIP: r.geoIP ? JSON.parse(r.geoIP).filter(Boolean) : undefined,
      asn: r.asn || undefined,
    }));
  }

  // Get top domains for a specific backend
  getTopDomains(backendId: number, limit = 10, start?: string, end?: string): DomainStats[] {
    return this.getDomainStats(backendId, limit, start, end);
  }

  // Get top IPs for a specific backend
  getTopIPs(backendId: number, limit = 10, start?: string, end?: string): IPStats[] {
    return this.getIPStats(backendId, limit, start, end);
  }

  // Get domain stats with server-side pagination, sorting and search
  getDomainStatsPaginated(backendId: number, opts: {
    offset?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: string;
    search?: string;
    start?: string;
    end?: string;
  } = {}): { data: DomainStats[]; total: number } {
    const offset = opts.offset ?? 0;
    const limit = Math.min(opts.limit ?? 50, 200);
    const sortOrder = opts.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const search = opts.search?.trim() || '';
    const range = this.parseMinuteRange(opts.start, opts.end);

    const sortColumnMap: Record<string, string> = {
      domain: 'domain',
      totalDownload: 'total_download',
      totalUpload: 'total_upload',
      totalConnections: 'total_connections',
      lastSeen: 'last_seen',
    };
    const sortColumn = sortColumnMap[opts.sortBy || 'totalDownload'] || 'total_download';

    if (range) {
      const rangeSortColumnMap: Record<string, string> = {
        domain: 'domain',
        totalDownload: 'totalDownload',
        totalUpload: 'totalUpload',
        totalConnections: 'totalConnections',
        lastSeen: 'lastSeen',
      };
      const rangeSortColumn =
        rangeSortColumnMap[opts.sortBy || 'totalDownload'] || 'totalDownload';

      const whereSearch = search ? 'AND domain LIKE ?' : '';
      const baseParams: any[] = [backendId, range.startMinute, range.endMinute];
      const searchParams: any[] = search ? [`%${search}%`] : [];

      const countStmt = this.db.prepare(`
        SELECT COUNT(*) as total
        FROM (
          SELECT domain
          FROM minute_dim_stats
          WHERE backend_id = ? AND minute >= ? AND minute <= ? AND domain != '' ${whereSearch}
          GROUP BY domain
        )
      `);
      const { total } = countStmt.get(
        ...baseParams,
        ...searchParams,
      ) as { total: number };

      const dataStmt = this.db.prepare(`
        SELECT
          domain,
          SUM(upload) as totalUpload,
          SUM(download) as totalDownload,
          SUM(connections) as totalConnections,
          MAX(minute) as lastSeen,
          GROUP_CONCAT(DISTINCT ip) as ips,
          GROUP_CONCAT(DISTINCT rule) as rules,
          GROUP_CONCAT(DISTINCT chain) as chains
        FROM minute_dim_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ? AND domain != '' ${whereSearch}
        GROUP BY domain
        ORDER BY ${rangeSortColumn} ${sortOrder}
        LIMIT ? OFFSET ?
      `);
      const rows = dataStmt.all(
        ...baseParams,
        ...searchParams,
        limit,
        offset,
      ) as Array<{
        domain: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
        lastSeen: string;
        ips: string | null;
        rules: string | null;
        chains: string | null;
      }>;

      const data = rows.map(row => {
        const rules = row.rules ? row.rules.split(',').filter(Boolean) : [];
        const chains = row.chains ? row.chains.split(',').filter(Boolean) : [];
        return {
          ...row,
          ips: row.ips ? row.ips.split(',').filter(Boolean) : [],
          rules,
          chains: this.expandShortChainsForRules(backendId, chains, rules),
        };
      }) as DomainStats[];

      return { data, total };
    }

    const whereClause = search
      ? 'WHERE backend_id = ? AND domain LIKE ?'
      : 'WHERE backend_id = ?';
    const params: any[] = search
      ? [backendId, `%${search}%`]
      : [backendId];

    const countStmt = this.db.prepare(
      `SELECT COUNT(*) as total FROM domain_stats ${whereClause}`
    );
    const { total } = countStmt.get(...params) as { total: number };

    const dataStmt = this.db.prepare(`
      SELECT domain, total_upload as totalUpload, total_download as totalDownload,
             total_connections as totalConnections, last_seen as lastSeen, ips, rules, chains
      FROM domain_stats
      ${whereClause}
      ORDER BY ${sortColumn} ${sortOrder}
      LIMIT ? OFFSET ?
    `);
    const rows = dataStmt.all(...params, limit, offset) as Array<{
      domain: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
      lastSeen: string;
      ips: string | null;
      rules: string | null;
      chains: string | null;
    }>;

    const data = rows.map(row => {
      const rules = row.rules ? row.rules.split(',').filter(Boolean) : [];
      const chains = row.chains ? row.chains.split(',').filter(Boolean) : [];
      return {
        ...row,
        ips: row.ips ? row.ips.split(',') : [],
        rules,
        chains: this.expandShortChainsForRules(backendId, chains, rules),
      };
    }) as DomainStats[];

    return { data, total };
  }

  // Get IP stats with server-side pagination, sorting and search
  getIPStatsPaginated(backendId: number, opts: {
    offset?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: string;
    search?: string;
    start?: string;
    end?: string;
  } = {}): { data: IPStats[]; total: number } {
    const offset = opts.offset ?? 0;
    const limit = Math.min(opts.limit ?? 50, 200);
    const sortOrder = opts.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const search = opts.search?.trim() || '';
    const range = this.parseMinuteRange(opts.start, opts.end);

    const sortColumnMap: Record<string, string> = {
      ip: 'i.ip',
      totalDownload: 'i.total_download',
      totalUpload: 'i.total_upload',
      totalConnections: 'i.total_connections',
      lastSeen: 'i.last_seen',
    };
    const sortColumn = sortColumnMap[opts.sortBy || 'totalDownload'] || 'i.total_download';

    if (range) {
      const rangeSortColumnMap: Record<string, string> = {
        ip: 'agg.ip',
        totalDownload: 'agg.totalDownload',
        totalUpload: 'agg.totalUpload',
        totalConnections: 'agg.totalConnections',
        lastSeen: 'agg.lastSeen',
      };
      const rangeSortColumn =
        rangeSortColumnMap[opts.sortBy || 'totalDownload'] || 'agg.totalDownload';

      const whereSearch = search
        ? "AND (ip LIKE ? OR domain LIKE ?)"
        : "";
      const baseParams: any[] = [backendId, range.startMinute, range.endMinute];
      const searchParams: any[] = search
        ? [`%${search}%`, `%${search}%`]
        : [];

      const countStmt = this.db.prepare(`
        SELECT COUNT(*) as total
        FROM (
          SELECT ip
          FROM minute_dim_stats
          WHERE backend_id = ? AND minute >= ? AND minute <= ? AND ip != '' ${whereSearch}
          GROUP BY ip
        )
      `);
      const { total } = countStmt.get(
        ...baseParams,
        ...searchParams,
      ) as { total: number };

      const dataStmt = this.db.prepare(`
        WITH agg AS (
          SELECT
            ip,
            GROUP_CONCAT(DISTINCT CASE WHEN domain != '' THEN domain END) as domains,
            GROUP_CONCAT(DISTINCT rule) as rules,
            SUM(upload) as totalUpload,
            SUM(download) as totalDownload,
            SUM(connections) as totalConnections,
            MAX(minute) as lastSeen,
            GROUP_CONCAT(DISTINCT chain) as chains
          FROM minute_dim_stats
          WHERE backend_id = ? AND minute >= ? AND minute <= ? AND ip != '' ${whereSearch}
          GROUP BY ip
        )
        SELECT
          agg.ip,
          agg.domains,
          agg.rules,
          agg.totalUpload,
          agg.totalDownload,
          agg.totalConnections,
          agg.lastSeen,
          COALESCE(i.asn, g.asn) as asn,
          CASE
            WHEN g.country IS NOT NULL THEN
              json_array(
                g.country,
                COALESCE(g.country_name, g.country),
                COALESCE(g.city, ''),
                COALESCE(g.as_name, '')
              )
            WHEN i.geoip IS NOT NULL THEN
              json(i.geoip)
            ELSE
              NULL
          END as geoIP,
          agg.chains
        FROM agg
        LEFT JOIN ip_stats i ON i.backend_id = ? AND i.ip = agg.ip
        LEFT JOIN geoip_cache g ON g.ip = agg.ip
        ORDER BY ${rangeSortColumn} ${sortOrder}
        LIMIT ? OFFSET ?
      `);
      const rows = dataStmt.all(
        ...baseParams,
        ...searchParams,
        backendId,
        limit,
        offset,
      ) as Array<{
        ip: string;
        domains: string;
        rules: string | null;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
        lastSeen: string;
        asn: string | null;
        geoIP: string | null;
        chains: string | null;
      }>;

      const data = rows.map(row => {
        const rules = row.rules ? row.rules.split(',').filter(Boolean) : [];
        const chains = row.chains ? row.chains.split(',').filter(Boolean) : [];
        return {
          ip: row.ip,
          domains: row.domains ? row.domains.split(',').filter(Boolean) : [],
          totalUpload: row.totalUpload,
          totalDownload: row.totalDownload,
          totalConnections: row.totalConnections,
          lastSeen: row.lastSeen,
          geoIP: row.geoIP ? JSON.parse(row.geoIP).filter(Boolean) : undefined,
          asn: row.asn || undefined,
          chains: this.expandShortChainsForRules(backendId, chains, rules),
        };
      }) as IPStats[];

      return { data, total };
    }

    const whereClause = search
      ? "WHERE i.backend_id = ? AND i.ip != '' AND (i.ip LIKE ? OR i.domains LIKE ?)"
      : "WHERE i.backend_id = ? AND i.ip != ''";
    const params: any[] = search
      ? [backendId, `%${search}%`, `%${search}%`]
      : [backendId];

    const countStmt = this.db.prepare(
      `SELECT COUNT(*) as total FROM ip_stats i ${whereClause}`
    );
    const { total } = countStmt.get(...params) as { total: number };

    const dataStmt = this.db.prepare(`
      SELECT
        i.ip,
        i.domains,
        i.total_upload as totalUpload,
        i.total_download as totalDownload,
        i.total_connections as totalConnections,
        i.last_seen as lastSeen,
        i.rules,
        COALESCE(i.asn, g.asn) as asn,
        CASE
          WHEN g.country IS NOT NULL THEN
            json_array(
              g.country,
              COALESCE(g.country_name, g.country),
              COALESCE(g.city, ''),
              COALESCE(g.as_name, '')
            )
          WHEN i.geoip IS NOT NULL THEN
            json(i.geoip)
          ELSE
            NULL
        END as geoIP,
        i.chains
      FROM ip_stats i
      LEFT JOIN geoip_cache g ON i.ip = g.ip
      ${whereClause}
      ORDER BY ${sortColumn} ${sortOrder}
      LIMIT ? OFFSET ?
    `);
    const rows = dataStmt.all(...params, limit, offset) as Array<{
      ip: string;
      domains: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
      lastSeen: string;
      rules: string | null;
      asn: string | null;
      geoIP: string | null;
      chains: string | null;
    }>;

    const data = rows.map(row => {
      const rules = row.rules ? row.rules.split(',').filter(Boolean) : [];
      const chains = row.chains ? row.chains.split(',').filter(Boolean) : [];
      return {
        ip: row.ip,
        domains: row.domains ? row.domains.split(',') : [],
        totalUpload: row.totalUpload,
        totalDownload: row.totalDownload,
        totalConnections: row.totalConnections,
        lastSeen: row.lastSeen,
        geoIP: row.geoIP ? JSON.parse(row.geoIP).filter(Boolean) : undefined,
        asn: row.asn || undefined,
        chains: this.expandShortChainsForRules(backendId, chains, rules),
      };
    }) as IPStats[];

    return { data, total };
  }

  // Get proxy stats for a specific backend
  getProxyStats(backendId: number, start?: string, end?: string): ProxyStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          chain,
          SUM(upload) as totalUpload,
          SUM(download) as totalDownload,
          SUM(connections) as totalConnections,
          MAX(minute) as lastSeen
        FROM minute_dim_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ?
        GROUP BY chain
        ORDER BY (SUM(upload) + SUM(download)) DESC
      `);
      const rows = stmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
      ) as ProxyStats[];
      return this.aggregateProxyStatsByFirstHop(rows);
    }

    const stmt = this.db.prepare(`
      SELECT chain, total_upload as totalUpload, total_download as totalDownload, 
             total_connections as totalConnections, last_seen as lastSeen
      FROM proxy_stats
      WHERE backend_id = ?
      ORDER BY (total_upload + total_download) DESC
    `);
    const rows = stmt.all(backendId) as ProxyStats[];
    return this.aggregateProxyStatsByFirstHop(rows);
  }

  // Get rule stats for a specific backend
  getRuleStats(backendId: number, start?: string, end?: string): RuleStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          rule,
          MAX(chain) as finalProxy,
          SUM(upload) as totalUpload,
          SUM(download) as totalDownload,
          SUM(connections) as totalConnections,
          MAX(minute) as lastSeen
        FROM minute_dim_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ?
        GROUP BY rule
        ORDER BY (SUM(upload) + SUM(download)) DESC
      `);
      return stmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
      ) as RuleStats[];
    }

    const stmt = this.db.prepare(`
      SELECT rule, final_proxy as finalProxy, total_upload as totalUpload, total_download as totalDownload, 
             total_connections as totalConnections, last_seen as lastSeen
      FROM rule_stats
      WHERE backend_id = ?
      ORDER BY (total_upload + total_download) DESC
    `);
    return stmt.all(backendId) as RuleStats[];
  }

  // Get rule-proxy mapping for a specific backend
  getRuleProxyMap(backendId: number): Array<{ rule: string; proxies: string[] }> {
    const stmt = this.db.prepare(`
      SELECT rule, proxy FROM rule_proxy_map WHERE backend_id = ? ORDER BY rule, proxy
    `);
    const rows = stmt.all(backendId) as Array<{ rule: string; proxy: string }>;
    
    const map = new Map<string, string[]>();
    for (const row of rows) {
      if (!map.has(row.rule)) {
        map.set(row.rule, []);
      }
      map.get(row.rule)!.push(row.proxy);
    }
    
    return Array.from(map.entries()).map(([rule, proxies]) => ({ rule, proxies }));
  }

  // Update ASN info for an IP
  updateASNInfo(ip: string, asn: string, org: string) {
    const stmt = this.db.prepare(`
      INSERT INTO asn_cache (ip, asn, org, queried_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(ip) DO UPDATE SET
        asn = ?,
        org = ?,
        queried_at = CURRENT_TIMESTAMP
    `);
    stmt.run(ip, asn, org, asn, org);
  }

  // Get ASN info for IPs
  getASNInfo(ips: string[]): Array<{ ip: string; asn: string; org: string }> {
    const stmt = this.db.prepare(`
      SELECT ip, asn, org FROM asn_cache WHERE ip IN (${ips.map(() => '?').join(',')})
    `);
    return stmt.all(...ips) as Array<{ ip: string; asn: string; org: string }>;
  }

  // Get ASN info for a single IP
  getASNInfoForIP(ip: string): { ip: string; asn: string; org: string } | undefined {
    const stmt = this.db.prepare(`SELECT ip, asn, org FROM asn_cache WHERE ip = ?`);
    return stmt.get(ip) as { ip: string; asn: string; org: string } | undefined;
  }

  // Get GeoIP info for an IP (from cache)
  getIPGeolocation(ip: string): { 
    country: string; 
    country_name: string; 
    city: string;
    asn: string;
    as_name: string;
    as_domain: string;
    continent: string;
    continent_name: string;
  } | undefined {
    const stmt = this.db.prepare(`
      SELECT country, country_name, city, asn, as_name, as_domain, continent, continent_name 
      FROM geoip_cache 
      WHERE ip = ?
    `);
    return stmt.get(ip) as { 
      country: string; 
      country_name: string; 
      city: string;
      asn: string;
      as_name: string;
      as_domain: string;
      continent: string;
      continent_name: string;
    } | undefined;
  }

  // Save GeoIP info to cache
  saveIPGeolocation(ip: string, geo: {
    country: string;
    country_name: string;
    city: string;
    asn: string;
    as_name: string;
    as_domain: string;
    continent: string;
    continent_name: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO geoip_cache (ip, country, country_name, city, asn, as_name, as_domain, continent, continent_name, queried_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(ip) DO UPDATE SET
        country = ?,
        country_name = ?,
        city = ?,
        asn = ?,
        as_name = ?,
        as_domain = ?,
        continent = ?,
        continent_name = ?,
        queried_at = CURRENT_TIMESTAMP
    `);
    stmt.run(
      ip, geo.country, geo.country_name, geo.city, geo.asn, geo.as_name, geo.as_domain, geo.continent, geo.continent_name,
      geo.country, geo.country_name, geo.city, geo.asn, geo.as_name, geo.as_domain, geo.continent, geo.continent_name
    );
  }

  // Get summary stats for a specific backend
  getSummary(
    backendId: number,
    start?: string,
    end?: string,
  ): { totalConnections: number; totalUpload: number; totalDownload: number; uniqueDomains: number; uniqueIPs: number } {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const trafficStmt = this.db.prepare(`
        SELECT
          COALESCE(SUM(connections), 0) as connections,
          COALESCE(SUM(upload), 0) as upload,
          COALESCE(SUM(download), 0) as download
        FROM minute_dim_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ?
      `);
      const { connections, upload, download } = trafficStmt.get(
        backendId,
        range.startMinute,
        range.endMinute,
      ) as {
        connections: number;
        upload: number;
        download: number;
      };

      const domainsStmt = this.db.prepare(`
        SELECT COUNT(DISTINCT domain) as count
        FROM minute_dim_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ? AND domain != ''
      `);
      const uniqueDomains = (domainsStmt.get(
        backendId,
        range.startMinute,
        range.endMinute,
      ) as { count: number }).count;

      const ipsStmt = this.db.prepare(`
        SELECT COUNT(DISTINCT ip) as count
        FROM minute_dim_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ? AND ip != ''
      `);
      const uniqueIPs = (ipsStmt.get(
        backendId,
        range.startMinute,
        range.endMinute,
      ) as { count: number }).count;

      return {
        totalConnections: connections,
        totalUpload: upload,
        totalDownload: download,
        uniqueDomains,
        uniqueIPs,
      };
    }

    // Calculate totals from ip_stats to include traffic with unknown domains
    const trafficStmt = this.db.prepare(`
      SELECT 
        COALESCE(SUM(total_connections), 0) as connections,
        COALESCE(SUM(total_upload), 0) as upload, 
        COALESCE(SUM(total_download), 0) as download
      FROM ip_stats 
      WHERE backend_id = ?
    `);
    const { connections, upload, download } = trafficStmt.get(backendId) as { 
      connections: number; 
      upload: number; 
      download: number;
    };

    const domainsStmt = this.db.prepare(`
      SELECT COUNT(DISTINCT domain) as count FROM domain_stats WHERE backend_id = ?
    `);
    const uniqueDomains = (domainsStmt.get(backendId) as { count: number }).count;

    const ipsStmt = this.db.prepare(`
      SELECT COUNT(DISTINCT ip) as count FROM ip_stats WHERE backend_id = ?
    `);
    const uniqueIPs = (ipsStmt.get(backendId) as { count: number }).count;

    return {
      totalConnections: connections,
      totalUpload: upload,
      totalDownload: download,
      uniqueDomains,
      uniqueIPs
    };
  }

  // Get per-proxy traffic breakdown for a specific domain
  getDomainProxyStats(
    backendId: number,
    domain: string,
    start?: string,
    end?: string,
    sourceIP?: string,
    sourceChain?: string,
  ): ProxyTrafficStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range || sourceIP || sourceChain) {
      const conditions = ["backend_id = ?", "domain = ?"];
      const params: Array<string | number> = [backendId, domain];
      if (range) {
        conditions.push("minute >= ?", "minute <= ?");
        params.push(range.startMinute, range.endMinute);
      }
      if (sourceIP) {
        conditions.push("source_ip = ?");
        params.push(sourceIP);
      }
      if (sourceChain) {
        conditions.push("(chain = ? OR chain LIKE ?)");
        params.push(sourceChain, `${sourceChain} > %`);
      }

      const stmt = this.db.prepare(`
        SELECT
          chain,
          SUM(upload) as totalUpload,
          SUM(download) as totalDownload,
          SUM(connections) as totalConnections
        FROM minute_dim_stats
        WHERE ${conditions.join(" AND ")}
        GROUP BY chain
        ORDER BY (SUM(upload) + SUM(download)) DESC
      `);
      return stmt.all(...params) as ProxyTrafficStats[];
    }

    const stmt = this.db.prepare(`
      SELECT chain,
             total_upload as totalUpload,
             total_download as totalDownload,
             total_connections as totalConnections
      FROM domain_proxy_stats
      WHERE backend_id = ? AND domain = ?
      ORDER BY (total_upload + total_download) DESC
    `);
    return stmt.all(backendId, domain) as ProxyTrafficStats[];
  }

  // Get per-proxy traffic breakdown for a specific IP
  getIPProxyStats(
    backendId: number,
    ip: string,
    start?: string,
    end?: string,
    sourceIP?: string,
    sourceChain?: string,
  ): ProxyTrafficStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range || sourceIP || sourceChain) {
      const conditions = ["backend_id = ?", "ip = ?"];
      const params: Array<string | number> = [backendId, ip];
      if (range) {
        conditions.push("minute >= ?", "minute <= ?");
        params.push(range.startMinute, range.endMinute);
      }
      if (sourceIP) {
        conditions.push("source_ip = ?");
        params.push(sourceIP);
      }
      if (sourceChain) {
        conditions.push("(chain = ? OR chain LIKE ?)");
        params.push(sourceChain, `${sourceChain} > %`);
      }

      const stmt = this.db.prepare(`
        SELECT
          chain,
          SUM(upload) as totalUpload,
          SUM(download) as totalDownload,
          SUM(connections) as totalConnections
        FROM minute_dim_stats
        WHERE ${conditions.join(" AND ")}
        GROUP BY chain
        ORDER BY (SUM(upload) + SUM(download)) DESC
      `);
      return stmt.all(...params) as ProxyTrafficStats[];
    }

    const stmt = this.db.prepare(`
      SELECT chain,
             total_upload as totalUpload,
             total_download as totalDownload,
             total_connections as totalConnections
      FROM ip_proxy_stats
      WHERE backend_id = ? AND ip = ?
      ORDER BY (total_upload + total_download) DESC
    `);
    return stmt.all(backendId, ip) as ProxyTrafficStats[];
  }

  // Get domains for a specific proxy/node
  getProxyDomains(
    backendId: number,
    chain: string,
    limit = 50,
    start?: string,
    end?: string,
  ): DomainStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          domain,
          SUM(upload) as totalUpload,
          SUM(download) as totalDownload,
          SUM(connections) as totalConnections,
          MAX(minute) as lastSeen,
          GROUP_CONCAT(DISTINCT ip) as ips
        FROM minute_dim_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ? AND (chain = ? OR chain LIKE ?) AND domain != ''
        GROUP BY domain
        ORDER BY (SUM(upload) + SUM(download)) DESC
        LIMIT ?
      `);
      const rows = stmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
        chain,
        `${chain} > %`,
        limit,
      ) as Array<{
        domain: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
        lastSeen: string;
        ips: string | null;
      }>;

      return rows.map(row => ({
        ...row,
        ips: row.ips ? row.ips.split(',').filter(Boolean) : [],
        rules: [],
        chains: [chain],
      })) as DomainStats[];
    }

    const stmt = this.db.prepare(`
      SELECT
        dps.domain,
        dps.total_upload as totalUpload,
        dps.total_download as totalDownload,
        dps.total_connections as totalConnections,
        dps.last_seen as lastSeen,
        ds.ips
      FROM domain_proxy_stats dps
      LEFT JOIN domain_stats ds ON dps.backend_id = ds.backend_id AND dps.domain = ds.domain
      WHERE dps.backend_id = ? AND (dps.chain = ? OR dps.chain LIKE ?)
      ORDER BY (dps.total_upload + dps.total_download) DESC
      LIMIT ?
    `);
    const rows = stmt.all(backendId, chain, `${chain} > %`, limit) as Array<{
      domain: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
      lastSeen: string;
      ips: string | null;
    }>;

    return rows.map(row => ({
      ...row,
      ips: row.ips ? row.ips.split(',').filter(Boolean) : [],
      rules: [],
      chains: [chain],
    })) as DomainStats[];
  }

  // Get IPs for a specific proxy/node
  getProxyIPs(
    backendId: number,
    chain: string,
    limit = 50,
    start?: string,
    end?: string,
  ): IPStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          m.ip,
          SUM(m.upload) as totalUpload,
          SUM(m.download) as totalDownload,
          SUM(m.connections) as totalConnections,
          MAX(m.minute) as lastSeen,
          GROUP_CONCAT(DISTINCT CASE WHEN m.domain != '' THEN m.domain END) as domains,
          COALESCE(i.asn, g.asn) as asn,
          CASE
            WHEN g.country IS NOT NULL THEN
              json_array(
                g.country,
                COALESCE(g.country_name, g.country),
                COALESCE(g.city, ''),
                COALESCE(g.as_name, '')
              )
            WHEN i.geoip IS NOT NULL THEN
              json(i.geoip)
            ELSE
              NULL
          END as geoIP
        FROM minute_dim_stats m
        LEFT JOIN ip_stats i ON m.backend_id = i.backend_id AND m.ip = i.ip
        LEFT JOIN geoip_cache g ON m.ip = g.ip
        WHERE m.backend_id = ? AND m.minute >= ? AND m.minute <= ? AND (m.chain = ? OR m.chain LIKE ?) AND m.ip != ''
        GROUP BY m.ip
        ORDER BY (SUM(m.upload) + SUM(m.download)) DESC
        LIMIT ?
      `);
      const rows = stmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
        chain,
        `${chain} > %`,
        limit,
      ) as Array<{
        ip: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
        lastSeen: string;
        domains: string | null;
        asn: string | null;
        geoIP: string | null;
      }>;

      return rows.map(row => ({
        ...row,
        domains: row.domains ? row.domains.split(',').filter(Boolean) : [],
        chains: [chain],
        asn: row.asn || undefined,
        geoIP: row.geoIP ? JSON.parse(row.geoIP).filter(Boolean) : undefined,
      })) as IPStats[];
    }

    const stmt = this.db.prepare(`
      SELECT
        ips.ip,
        ips.total_upload as totalUpload,
        ips.total_download as totalDownload,
        ips.total_connections as totalConnections,
        ips.last_seen as lastSeen,
        ips.domains
      FROM ip_proxy_stats ips
      WHERE ips.backend_id = ? AND (ips.chain = ? OR ips.chain LIKE ?) AND ips.ip != ''
      ORDER BY (ips.total_upload + ips.total_download) DESC
      LIMIT ?
    `);
    const rows = stmt.all(backendId, chain, `${chain} > %`, limit) as Array<{
      ip: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
      lastSeen: string;
      domains: string | null;
    }>;

    // Get geoIP info for each IP
    const ipList = rows.map(r => r.ip).filter(ip => ip && ip.trim() !== '');
    if (ipList.length === 0) {
      return [];
    }

    const placeholders = ipList.map(() => '?').join(',');
    const geoStmt = this.db.prepare(`
      SELECT
        ip,
        CASE
          WHEN country IS NOT NULL THEN
            json_array(
              country,
              COALESCE(country_name, country),
              COALESCE(city, ''),
              COALESCE(as_name, '')
            )
          ELSE
            NULL
        END as geoIP
      FROM geoip_cache
      WHERE ip IN (${placeholders})
    `);
    const geoRows = geoStmt.all(...ipList) as Array<{
      ip: string;
      geoIP: string | null;
    }>;

    const geoMap = new Map(geoRows.map(r => [r.ip, r.geoIP]));

    return rows.map(row => ({
      ...row,
      domains: row.domains ? row.domains.split(',').filter(Boolean) : [],
      chains: [chain],
      geoIP: geoMap.get(row.ip) ? JSON.parse(geoMap.get(row.ip)!).filter(Boolean) : undefined,
    })) as IPStats[];
  }

  // Get domains for a specific rule
  getRuleDomains(
    backendId: number,
    rule: string,
    limit = 50,
    start?: string,
    end?: string,
  ): DomainStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          domain,
          SUM(upload) as totalUpload,
          SUM(download) as totalDownload,
          SUM(connections) as totalConnections,
          MAX(minute) as lastSeen,
          GROUP_CONCAT(DISTINCT ip) as ips,
          GROUP_CONCAT(DISTINCT chain) as chains
        FROM minute_dim_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ? AND rule = ? AND domain != ''
        GROUP BY domain
        ORDER BY (SUM(upload) + SUM(download)) DESC
        LIMIT ?
      `);
      const rows = stmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
        rule,
        limit,
      ) as Array<{
        domain: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
        lastSeen: string;
        ips: string | null;
        chains: string | null;
      }>;

      return rows.map(row => {
        const chains = row.chains ? row.chains.split(',').filter(Boolean) : [];
        return {
          domain: row.domain,
          totalUpload: row.totalUpload,
          totalDownload: row.totalDownload,
          totalConnections: row.totalConnections,
          lastSeen: row.lastSeen,
          ips: row.ips ? row.ips.split(',').filter(Boolean) : [],
          chains: this.expandShortChainsForRules(backendId, chains, [rule]),
          rules: [rule],
        };
      }) as DomainStats[];
    }

    // Query rule_domain_traffic for accurate all-time per-rule domain traffic
    const stmt = this.db.prepare(`
      SELECT
        rdt.domain,
        rdt.total_upload as totalUpload,
        rdt.total_download as totalDownload,
        rdt.total_connections as totalConnections,
        rdt.last_seen as lastSeen,
        ds.ips,
        ds.chains
      FROM rule_domain_traffic rdt
      LEFT JOIN domain_stats ds ON rdt.backend_id = ds.backend_id AND rdt.domain = ds.domain
      WHERE rdt.backend_id = ? AND rdt.rule = ?
      ORDER BY (rdt.total_upload + rdt.total_download) DESC
      LIMIT ?
    `);

    const rows = stmt.all(backendId, rule, limit) as Array<{
      domain: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
      lastSeen: string;
      ips: string | null;
      chains: string | null;
    }>;

    return rows.map(row => ({
      domain: row.domain,
      totalUpload: row.totalUpload,
      totalDownload: row.totalDownload,
      totalConnections: row.totalConnections,
      lastSeen: row.lastSeen,
      ips: row.ips ? row.ips.split(',').filter(Boolean) : [],
      chains: this.expandShortChainsForRules(
        backendId,
        row.chains ? row.chains.split(',').filter(Boolean) : [],
        [rule],
      ),
      rules: [rule],
    })) as DomainStats[];
  }

  // Get IPs for a specific rule
  getRuleIPs(
    backendId: number,
    rule: string,
    limit = 50,
    start?: string,
    end?: string,
  ): IPStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          m.ip,
          SUM(m.upload) as totalUpload,
          SUM(m.download) as totalDownload,
          SUM(m.connections) as totalConnections,
          MAX(m.minute) as lastSeen,
          GROUP_CONCAT(DISTINCT CASE WHEN m.domain != '' THEN m.domain END) as domains,
          GROUP_CONCAT(DISTINCT m.chain) as chains,
          COALESCE(i.asn, g.asn) as asn,
          CASE
            WHEN g.country IS NOT NULL THEN
              json_array(
                g.country,
                COALESCE(g.country_name, g.country),
                COALESCE(g.city, ''),
                COALESCE(g.as_name, '')
              )
            WHEN i.geoip IS NOT NULL THEN
              json(i.geoip)
            ELSE
              NULL
          END as geoIPData
        FROM minute_dim_stats m
        LEFT JOIN ip_stats i ON m.backend_id = i.backend_id AND m.ip = i.ip
        LEFT JOIN geoip_cache g ON m.ip = g.ip
        WHERE m.backend_id = ? AND m.minute >= ? AND m.minute <= ? AND m.rule = ? AND m.ip != ''
        GROUP BY m.ip
        ORDER BY (SUM(m.upload) + SUM(m.download)) DESC
        LIMIT ?
      `);

      const rows = stmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
        rule,
        limit,
      ) as Array<{
        ip: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
        lastSeen: string;
        domains: string | null;
        chains: string | null;
        asn: string | null;
        geoIPData: string | null;
      }>;

      return rows.map(row => {
        const chains = row.chains ? row.chains.split(',').filter(Boolean) : [];
        return {
          ip: row.ip,
          totalUpload: row.totalUpload,
          totalDownload: row.totalDownload,
          totalConnections: row.totalConnections,
          lastSeen: row.lastSeen,
          domains: row.domains ? row.domains.split(',').filter(Boolean) : [],
          chains: this.expandShortChainsForRules(backendId, chains, [rule]),
          asn: row.asn || undefined,
          geoIP: row.geoIPData ? JSON.parse(row.geoIPData).filter(Boolean) : undefined,
        };
      }) as IPStats[];
    }

    // Query rule_ip_traffic for accurate all-time per-rule IP traffic
    const stmt = this.db.prepare(`
      SELECT
        rit.ip,
        rit.total_upload as totalUpload,
        rit.total_download as totalDownload,
        rit.total_connections as totalConnections,
        rit.last_seen as lastSeen,
        i.domains,
        i.chains,
        COALESCE(i.asn, g.asn) as asn,
        CASE
          WHEN g.country IS NOT NULL THEN
            json_array(
              g.country,
              COALESCE(g.country_name, g.country),
              COALESCE(g.city, ''),
              COALESCE(g.as_name, '')
            )
          ELSE
            NULL
        END as geoIPData
      FROM rule_ip_traffic rit
      LEFT JOIN ip_stats i ON rit.backend_id = i.backend_id AND rit.ip = i.ip
      LEFT JOIN geoip_cache g ON rit.ip = g.ip
      WHERE rit.backend_id = ? AND rit.rule = ?
      ORDER BY (rit.total_upload + rit.total_download) DESC
      LIMIT ?
    `);

    const rows = stmt.all(backendId, rule, limit) as Array<{
      ip: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
      lastSeen: string;
      domains: string | null;
      chains: string | null;
      asn: string | null;
      geoIPData: string | null;
    }>;

    return rows.map(row => ({
      ip: row.ip,
      totalUpload: row.totalUpload,
      totalDownload: row.totalDownload,
      totalConnections: row.totalConnections,
      lastSeen: row.lastSeen,
      domains: row.domains ? row.domains.split(',').filter(Boolean) : [],
      chains: this.expandShortChainsForRules(
        backendId,
        row.chains ? row.chains.split(',').filter(Boolean) : [],
        [rule],
      ),
      asn: row.asn || undefined,
      geoIP: row.geoIPData ? JSON.parse(row.geoIPData).filter(Boolean) : undefined,
    })) as IPStats[];
  }

  // Get per-proxy traffic breakdown for a specific domain under a specific rule
  getRuleDomainProxyStats(
    backendId: number,
    rule: string,
    domain: string,
    start?: string,
    end?: string,
  ): ProxyTrafficStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          chain,
          SUM(upload) as totalUpload,
          SUM(download) as totalDownload,
          SUM(connections) as totalConnections
        FROM minute_dim_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ? AND rule = ? AND domain = ?
        GROUP BY chain
        ORDER BY (SUM(upload) + SUM(download)) DESC
      `);
      return stmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
        rule,
        domain,
      ) as ProxyTrafficStats[];
    }

    return [];
  }

  // Get IP details for a specific domain under a specific rule
  getRuleDomainIPDetails(
    backendId: number,
    rule: string,
    domain: string,
    start?: string,
    end?: string,
    limit = 100,
  ): IPStats[] {
    const range = this.parseMinuteRange(start, end);
    const conditions = ["m.backend_id = ?", "m.rule = ?", "m.domain = ?", "m.ip != ''"];
    const params: Array<string | number> = [backendId, rule, domain];

    if (range) {
      conditions.push("m.minute >= ?", "m.minute <= ?");
      params.push(range.startMinute, range.endMinute);
    }

    const stmt = this.db.prepare(`
      SELECT
        m.ip,
        GROUP_CONCAT(DISTINCT CASE WHEN m.domain != '' THEN m.domain END) as domains,
        SUM(m.upload) as totalUpload,
        SUM(m.download) as totalDownload,
        SUM(m.connections) as totalConnections,
        MAX(m.minute) as lastSeen,
        COALESCE(i.asn, g.asn) as asn,
        CASE
          WHEN g.country IS NOT NULL THEN
            json_array(
              g.country,
              COALESCE(g.country_name, g.country),
              COALESCE(g.city, ''),
              COALESCE(g.as_name, '')
            )
          WHEN i.geoip IS NOT NULL THEN
            json(i.geoip)
          ELSE
            NULL
        END as geoIP,
        GROUP_CONCAT(DISTINCT m.chain) as chains
      FROM minute_dim_stats m
      LEFT JOIN ip_stats i ON m.backend_id = i.backend_id AND m.ip = i.ip
      LEFT JOIN geoip_cache g ON m.ip = g.ip
      WHERE ${conditions.join(" AND ")}
      GROUP BY m.ip
      ORDER BY (SUM(m.upload) + SUM(m.download)) DESC
      LIMIT ?
    `);

    const rows = stmt.all(...params, limit) as Array<{
      ip: string;
      domains: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
      lastSeen: string;
      asn: string | null;
      geoIP: string | null;
      chains: string | null;
    }>;

    return rows.map(row => {
      const chains = row.chains ? row.chains.split(',').filter(Boolean) : [];
      return {
        ...row,
        domains: row.domains ? row.domains.split(',').filter(Boolean) : [],
        geoIP: row.geoIP ? JSON.parse(row.geoIP).filter(Boolean) : undefined,
        asn: row.asn || undefined,
        chains: this.expandShortChainsForRules(backendId, chains, [rule]),
      };
    }) as IPStats[];
  }

  // Get per-proxy traffic breakdown for a specific IP under a specific rule
  getRuleIPProxyStats(
    backendId: number,
    rule: string,
    ip: string,
    start?: string,
    end?: string,
  ): ProxyTrafficStats[] {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          chain,
          SUM(upload) as totalUpload,
          SUM(download) as totalDownload,
          SUM(connections) as totalConnections
        FROM minute_dim_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ? AND rule = ? AND ip = ?
        GROUP BY chain
        ORDER BY (SUM(upload) + SUM(download)) DESC
      `);
      return stmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
        rule,
        ip,
      ) as ProxyTrafficStats[];
    }

    return [];
  }

  // Get domain details for a specific IP under a specific rule
  getRuleIPDomainDetails(
    backendId: number,
    rule: string,
    ip: string,
    start?: string,
    end?: string,
    limit = 100,
  ): DomainStats[] {
    const range = this.parseMinuteRange(start, end);
    const conditions = ["backend_id = ?", "rule = ?", "ip = ?", "domain != ''"];
    const params: Array<string | number> = [backendId, rule, ip];

    if (range) {
      conditions.push("minute >= ?", "minute <= ?");
      params.push(range.startMinute, range.endMinute);
    }

    const stmt = this.db.prepare(`
      SELECT
        domain,
        GROUP_CONCAT(DISTINCT ip) as ips,
        SUM(upload) as totalUpload,
        SUM(download) as totalDownload,
        SUM(connections) as totalConnections,
        MAX(minute) as lastSeen,
        GROUP_CONCAT(DISTINCT CASE WHEN rule != '' THEN rule END) as rules,
        GROUP_CONCAT(DISTINCT chain) as chains
      FROM minute_dim_stats
      WHERE ${conditions.join(" AND ")}
      GROUP BY domain
      ORDER BY (SUM(upload) + SUM(download)) DESC
      LIMIT ?
    `);

    const rows = stmt.all(...params, limit) as Array<{
      domain: string;
      ips: string | null;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
      lastSeen: string;
      rules: string | null;
      chains: string | null;
    }>;

    return rows.map(row => {
      const rules = row.rules ? row.rules.split(',').filter(Boolean) : [];
      const chains = row.chains ? row.chains.split(',').filter(Boolean) : [];
      return {
        domain: row.domain,
        ips: row.ips ? row.ips.split(',').filter(Boolean) : [],
        totalUpload: row.totalUpload,
        totalDownload: row.totalDownload,
        totalConnections: row.totalConnections,
        lastSeen: row.lastSeen,
        rules,
        chains: this.expandShortChainsForRules(backendId, chains, rules),
      };
    }) as DomainStats[];
  }

  // Get rule chain flow for visualization
  getRuleChainFlow(
    backendId: number,
    rule: string,
    start?: string,
    end?: string,
  ): { nodes: Array<{ name: string; totalUpload: number; totalDownload: number; totalConnections: number }>; links: Array<{ source: number; target: number }> } {
    const range = this.parseMinuteRange(start, end);
    let rows: Array<{
      chain: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
    }>;

    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          chain,
          SUM(upload) as totalUpload,
          SUM(download) as totalDownload,
          SUM(connections) as totalConnections
        FROM minute_dim_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ? AND rule = ? AND chain != ''
        GROUP BY chain
      `);
      rows = stmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
        rule,
      ) as Array<{
        chain: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
      }>;

      const baselineStmt = this.db.prepare(`
        SELECT
          rule,
          chain,
          total_upload as totalUpload,
          total_download as totalDownload,
          total_connections as totalConnections
        FROM rule_chain_traffic
        WHERE backend_id = ? AND rule = ?
      `);
      const baselineRows = baselineStmt.all(backendId, rule) as Array<{
        rule: string;
        chain: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
      }>;
      const remapped = this.remapRangeRowsToFullChains(
        rows.map(r => ({
          rule,
          chain: r.chain,
          totalUpload: r.totalUpload,
          totalDownload: r.totalDownload,
          totalConnections: r.totalConnections,
        })),
        baselineRows,
      );
      rows = remapped.map(r => ({
        chain: r.chain,
        totalUpload: r.totalUpload,
        totalDownload: r.totalDownload,
        totalConnections: r.totalConnections,
      }));
    } else {
      // No time range: use cumulative table for fast query.
      const stmt = this.db.prepare(`
        SELECT chain, total_upload as totalUpload, total_download as totalDownload, total_connections as totalConnections
        FROM rule_chain_traffic
        WHERE backend_id = ? AND rule = ?
      `);
      rows = stmt.all(backendId, rule) as Array<{
        chain: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
      }>;
    }

    const nodeMap = new Map<string, { name: string; totalUpload: number; totalDownload: number; totalConnections: number }>();
    const linkSet = new Set<string>();

    for (const row of rows) {
      const flowPath = this.buildRuleFlowPath(rule, row.chain);
      if (flowPath.length < 2) continue;

      for (let i = 0; i < flowPath.length; i++) {
        const nodeName = flowPath[i];
        if (!nodeMap.has(nodeName)) {
          nodeMap.set(nodeName, { name: nodeName, totalUpload: 0, totalDownload: 0, totalConnections: 0 });
        }
        const node = nodeMap.get(nodeName)!;
        node.totalUpload += row.totalUpload;
        node.totalDownload += row.totalDownload;
        node.totalConnections += row.totalConnections;
      }

      for (let i = 0; i < flowPath.length - 1; i++) {
        linkSet.add(`${flowPath[i]}|${flowPath[i + 1]}`);
      }
    }

    const nodes = Array.from(nodeMap.values());
    const nodeIndexMap = new Map(nodes.map((n, i) => [n.name, i]));

    const links = Array.from(linkSet).map(linkStr => {
      const [sourceName, targetName] = linkStr.split('|');
      return { source: nodeIndexMap.get(sourceName)!, target: nodeIndexMap.get(targetName)! };
    });

    return { nodes, links };
  }

  // Get all rule chain flows merged into a unified DAG
  getAllRuleChainFlows(
    backendId: number,
    start?: string,
    end?: string,
  ): {
    nodes: Array<{ name: string; layer: number; nodeType: 'rule' | 'group' | 'proxy'; totalUpload: number; totalDownload: number; totalConnections: number; rules: string[] }>;
    links: Array<{ source: number; target: number; rules: string[] }>;
    rulePaths: Record<string, { nodeIndices: number[]; linkIndices: number[] }>;
    maxLayer: number;
  } {
    const range = this.parseMinuteRange(start, end);
    let rows: Array<{
      rule: string;
      chain: string;
      totalUpload: number;
      totalDownload: number;
      totalConnections: number;
    }>;

    if (range) {
      const stmt = this.db.prepare(`
        SELECT
          rule,
          chain,
          SUM(upload) as totalUpload,
          SUM(download) as totalDownload,
          SUM(connections) as totalConnections
        FROM minute_dim_stats
        WHERE backend_id = ? AND minute >= ? AND minute <= ? AND rule != '' AND chain != ''
        GROUP BY rule, chain
        ORDER BY rule, chain
      `);
      rows = stmt.all(
        backendId,
        range.startMinute,
        range.endMinute,
      ) as Array<{
        rule: string;
        chain: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
      }>;

      const baselineStmt = this.db.prepare(`
        SELECT
          rule,
          chain,
          total_upload as totalUpload,
          total_download as totalDownload,
          total_connections as totalConnections
        FROM rule_chain_traffic
        WHERE backend_id = ?
      `);
      const baselineRows = baselineStmt.all(backendId) as Array<{
        rule: string;
        chain: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
      }>;
      rows = this.remapRangeRowsToFullChains(rows, baselineRows);
    } else {
      // No time range: use cumulative table for fast query.
      const stmt = this.db.prepare(`
        SELECT rule, chain, total_upload as totalUpload, total_download as totalDownload, total_connections as totalConnections
        FROM rule_chain_traffic
        WHERE backend_id = ?
        ORDER BY rule, chain
      `);
      rows = stmt.all(backendId) as Array<{
        rule: string;
        chain: string;
        totalUpload: number;
        totalDownload: number;
        totalConnections: number;
      }>;
    }

    // nodeMap: name -> { stats + rules set + max layer }
    const nodeMap = new Map<string, {
      totalUpload: number; totalDownload: number; totalConnections: number;
      rules: Set<string>; layer: number;
    }>();
    // linkMap: "source|target" -> rules set
    const linkMap = new Map<string, Set<string>>();
    // rulePaths: rule -> Set of node names, Set of link keys
    const rulePathNodes = new Map<string, Set<string>>();
    const rulePathLinks = new Map<string, Set<string>>();

    for (const row of rows) {
      const rule = row.rule;
      if (!rulePathNodes.has(rule)) {
        rulePathNodes.set(rule, new Set());
        rulePathLinks.set(rule, new Set());
      }

      const flowPath = this.buildRuleFlowPath(rule, row.chain);
      if (flowPath.length < 2) continue;

      for (let i = 0; i < flowPath.length; i++) {
        const nodeName = flowPath[i];
        if (!nodeMap.has(nodeName)) {
          nodeMap.set(nodeName, {
            totalUpload: 0, totalDownload: 0, totalConnections: 0,
            rules: new Set(), layer: i,
          });
        }
        const node = nodeMap.get(nodeName)!;
        node.totalUpload += row.totalUpload;
        node.totalDownload += row.totalDownload;
        node.totalConnections += row.totalConnections;
        node.rules.add(rule);
        node.layer = Math.max(node.layer, i);

        rulePathNodes.get(rule)!.add(nodeName);
      }

      for (let i = 0; i < flowPath.length - 1; i++) {
        const linkKey = `${flowPath[i]}|${flowPath[i + 1]}`;
        if (!linkMap.has(linkKey)) {
          linkMap.set(linkKey, new Set());
        }
        linkMap.get(linkKey)!.add(rule);
        rulePathLinks.get(rule)!.add(linkKey);
      }
    }

    // Determine node types and fix layer assignments
    const nodeEntries = Array.from(nodeMap.entries());
    const nodeTypeMap = new Map<string, 'rule' | 'group' | 'proxy'>();
    let computedMaxLayer = 0;

    for (const [name, data] of nodeEntries) {
      const hasOutgoing = Array.from(linkMap.keys()).some(k => k.startsWith(name + '|'));
      const hasIncoming = Array.from(linkMap.keys()).some(k => k.endsWith('|' + name));

      if (!hasIncoming) {
        nodeTypeMap.set(name, 'rule');
        data.layer = 0;
      } else if (!hasOutgoing) {
        nodeTypeMap.set(name, 'proxy');
      } else {
        nodeTypeMap.set(name, 'group');
      }
      computedMaxLayer = Math.max(computedMaxLayer, data.layer);
    }

    // Force all proxy nodes to the rightmost column
    for (const [name, data] of nodeEntries) {
      if (nodeTypeMap.get(name) === 'proxy') {
        data.layer = computedMaxLayer;
      }
    }

    // Stable ordering is important to avoid unnecessary ReactFlow relayout/flicker.
    const nodeTypeOrder = (type: 'rule' | 'group' | 'proxy'): number => {
      if (type === 'rule') return 0;
      if (type === 'group') return 1;
      return 2;
    };
    const sortedNodeEntries = [...nodeEntries].sort(([nameA, dataA], [nameB, dataB]) => {
      if (dataA.layer !== dataB.layer) return dataA.layer - dataB.layer;
      const typeDiff = nodeTypeOrder(nodeTypeMap.get(nameA)!) - nodeTypeOrder(nodeTypeMap.get(nameB)!);
      if (typeDiff !== 0) return typeDiff;
      return nameA.localeCompare(nameB);
    });

    // Convert to arrays
    const nodes = sortedNodeEntries.map(([name, data]) => ({
      name,
      layer: data.layer,
      nodeType: nodeTypeMap.get(name)!,
      totalUpload: data.totalUpload,
      totalDownload: data.totalDownload,
      totalConnections: data.totalConnections,
      rules: Array.from(data.rules),
    }));

    const nodeIndexMap = new Map(nodes.map((n, i) => [n.name, i]));

    const links = Array.from(linkMap.entries())
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
      .map(([key, rules]) => {
      const [sourceName, targetName] = key.split('|');
      return {
        source: nodeIndexMap.get(sourceName)!,
        target: nodeIndexMap.get(targetName)!,
        rules: Array.from(rules),
      };
    });

    // Build rulePaths with index references
    const rulePaths: Record<string, { nodeIndices: number[]; linkIndices: number[] }> = {};
    for (const [rule, nodeNames] of rulePathNodes) {
      const nodeIndices = Array.from(nodeNames).map(n => nodeIndexMap.get(n)!).filter(i => i !== undefined);
      const linkIndices: number[] = [];
      const linkKeys = rulePathLinks.get(rule)!;
      links.forEach((link, idx) => {
        const sourceName = nodes[link.source].name;
        const targetName = nodes[link.target].name;
        if (linkKeys.has(`${sourceName}|${targetName}`)) {
          linkIndices.push(idx);
        }
      });
      rulePaths[rule] = { nodeIndices, linkIndices };
    }

    const maxLayer = nodes.reduce((max, n) => Math.max(max, n.layer), 0);

    return { nodes, links, rulePaths, maxLayer };
  }

  // Get recent connections for a specific backend
  // Returns empty array - connection_logs is no longer written to (replaced by aggregation tables)
  getRecentConnections(backendId: number, limit = 100): Connection[] {
    return [];
  }

  // Clean old data for a specific backend (or all backends if backendId is null)
  // days=0 means clear all data (no time limit)
  cleanupOldData(backendId: number | null, days: number): { deletedConnections: number; deletedLogs: number; deletedDomains: number; deletedIPs: number; deletedProxies: number; deletedRules: number } {
    let deletedConnections = 0;
    let deletedLogs = 0;
    let deletedDomains = 0;
    let deletedIPs = 0;
    let deletedProxies = 0;
    let deletedRules = 0;

    if (backendId !== null) {
      // Clean specific backend
      if (days === 0) {
        // Clear all data for this backend
        const minuteResult = this.db.prepare(`DELETE FROM minute_stats WHERE backend_id = ?`).run(backendId);
        deletedConnections = minuteResult.changes;
        deletedLogs = minuteResult.changes;
        this.db.prepare(`DELETE FROM minute_dim_stats WHERE backend_id = ?`).run(backendId);
        this.db.prepare(`DELETE FROM minute_country_stats WHERE backend_id = ?`).run(backendId);
        // Also clean old connection_logs if any remain from before migration
        this.db.prepare(`DELETE FROM connection_logs WHERE backend_id = ?`).run(backendId);

        // Clear stats tables
        const domainsStmt = this.db.prepare(`DELETE FROM domain_stats WHERE backend_id = ?`);
        deletedDomains = domainsStmt.run(backendId).changes;

        const ipsStmt = this.db.prepare(`DELETE FROM ip_stats WHERE backend_id = ?`);
        deletedIPs = ipsStmt.run(backendId).changes;

        const proxiesStmt = this.db.prepare(`DELETE FROM proxy_stats WHERE backend_id = ?`);
        deletedProxies = proxiesStmt.run(backendId).changes;

        const rulesStmt = this.db.prepare(`DELETE FROM rule_stats WHERE backend_id = ?`);
        deletedRules = rulesStmt.run(backendId).changes;

        // Clear country stats (Regions)
        this.db.prepare(`DELETE FROM country_stats WHERE backend_id = ?`).run(backendId);

        // Clear rule to proxy mapping
        this.db.prepare(`DELETE FROM rule_proxy_map WHERE backend_id = ?`).run(backendId);

        // Clear rule cross-reference tables
        this.db.prepare(`DELETE FROM rule_chain_traffic WHERE backend_id = ?`).run(backendId);
        this.db.prepare(`DELETE FROM rule_domain_traffic WHERE backend_id = ?`).run(backendId);
        this.db.prepare(`DELETE FROM rule_ip_traffic WHERE backend_id = ?`).run(backendId);

        // Clear new aggregation tables
        this.db.prepare(`DELETE FROM domain_proxy_stats WHERE backend_id = ?`).run(backendId);
        this.db.prepare(`DELETE FROM ip_proxy_stats WHERE backend_id = ?`).run(backendId);

        // Clear device stats
        this.db.prepare(`DELETE FROM device_stats WHERE backend_id = ?`).run(backendId);
        this.db.prepare(`DELETE FROM device_domain_stats WHERE backend_id = ?`).run(backendId);
        this.db.prepare(`DELETE FROM device_ip_stats WHERE backend_id = ?`).run(backendId);

        // Clear hourly stats (used for today traffic)
        this.db.prepare(`DELETE FROM hourly_stats WHERE backend_id = ?`).run(backendId);
      } else {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const minuteCutoff = cutoff.toISOString().slice(0, 16) + ':00';
        const minuteResult = this.db.prepare(`DELETE FROM minute_stats WHERE backend_id = ? AND minute < ?`).run(backendId, minuteCutoff);
        deletedConnections = minuteResult.changes;
        deletedLogs = minuteResult.changes;
        this.db.prepare(`DELETE FROM minute_dim_stats WHERE backend_id = ? AND minute < ?`).run(backendId, minuteCutoff);
        this.db.prepare(`DELETE FROM minute_country_stats WHERE backend_id = ? AND minute < ?`).run(backendId, minuteCutoff);
        // Also clean old connection_logs if any remain
        this.db.prepare(`DELETE FROM connection_logs WHERE backend_id = ? AND timestamp < ?`).run(backendId, cutoff.toISOString());
        // domain_proxy_stats and ip_proxy_stats are permanent aggregation tables (no time-based cleanup)
      }
    } else {
      // Clean all backends
      if (days === 0) {
        // Clear all data
        const minuteResult = this.db.prepare(`DELETE FROM minute_stats`).run();
        deletedConnections = minuteResult.changes;
        deletedLogs = minuteResult.changes;
        this.db.prepare(`DELETE FROM minute_dim_stats`).run();
        this.db.prepare(`DELETE FROM minute_country_stats`).run();
        // Also clean old connection_logs if any remain
        this.db.prepare(`DELETE FROM connection_logs`).run();

        // Clear all stats tables
        const domainsStmt = this.db.prepare(`DELETE FROM domain_stats`);
        deletedDomains = domainsStmt.run().changes;

        const ipsStmt = this.db.prepare(`DELETE FROM ip_stats`);
        deletedIPs = ipsStmt.run().changes;

        const proxiesStmt = this.db.prepare(`DELETE FROM proxy_stats`);
        deletedProxies = proxiesStmt.run().changes;

        const rulesStmt = this.db.prepare(`DELETE FROM rule_stats`);
        deletedRules = rulesStmt.run().changes;

        // Clear country stats (Regions)
        this.db.prepare(`DELETE FROM country_stats`).run();

        // Clear rule to proxy mapping
        this.db.prepare(`DELETE FROM rule_proxy_map`).run();

        // Clear rule cross-reference tables
        this.db.prepare(`DELETE FROM rule_chain_traffic`).run();
        this.db.prepare(`DELETE FROM rule_domain_traffic`).run();
        this.db.prepare(`DELETE FROM rule_ip_traffic`).run();

        // Clear new aggregation tables
        this.db.prepare(`DELETE FROM domain_proxy_stats`).run();
        this.db.prepare(`DELETE FROM ip_proxy_stats`).run();

        // Clear device stats
        this.db.prepare(`DELETE FROM device_stats`).run();
        this.db.prepare(`DELETE FROM device_domain_stats`).run();
        this.db.prepare(`DELETE FROM device_ip_stats`).run();

        // Clear hourly stats (used for today traffic)
        this.db.prepare(`DELETE FROM hourly_stats`).run();
      } else {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const minuteCutoff = cutoff.toISOString().slice(0, 16) + ':00';
        const minuteResult = this.db.prepare(`DELETE FROM minute_stats WHERE minute < ?`).run(minuteCutoff);
        deletedConnections = minuteResult.changes;
        deletedLogs = minuteResult.changes;
        this.db.prepare(`DELETE FROM minute_dim_stats WHERE minute < ?`).run(minuteCutoff);
        this.db.prepare(`DELETE FROM minute_country_stats WHERE minute < ?`).run(minuteCutoff);
        // Also clean old connection_logs if any remain
        this.db.prepare(`DELETE FROM connection_logs WHERE timestamp < ?`).run(cutoff.toISOString());
        // domain_proxy_stats and ip_proxy_stats are permanent aggregation tables (no time-based cleanup)
      }
    }

    // Vacuum database to reclaim space after clearing all data
    if (days === 0) {
      this.vacuum();
    }

    return { deletedConnections, deletedLogs, deletedDomains, deletedIPs, deletedProxies, deletedRules };
  }

  // Clean old ASN cache entries
  cleanupASNCache(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const stmt = this.db.prepare(`DELETE FROM asn_cache WHERE queried_at < ?`);
    const result = stmt.run(cutoff);
    return result.changes;
  }

  // Get database file size in bytes
  getDatabaseSize(): number {
    try {
      const stats = fs.statSync(this.dbPath);
      return stats.size;
    } catch {
      return 0;
    }
  }

  // Get minute stats count for a specific backend
  getConnectionLogsCount(backendId: number): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM minute_stats WHERE backend_id = ?
    `);
    const result = stmt.get(backendId) as { count: number };
    return result.count;
  }

  // Get total minute stats count (all backends)
  getTotalConnectionLogsCount(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM minute_stats`);
    const result = stmt.get() as { count: number };
    return result.count;
  }

  // Retention Configuration Methods

  // Get retention configuration
  getRetentionConfig(): DatabaseRetentionConfig {
    const connectionLogsDays = this.db.prepare(`
      SELECT value FROM app_config WHERE key = 'retention.connection_logs_days'
    `).get() as { value: string } | undefined;

    const hourlyStatsDays = this.db.prepare(`
      SELECT value FROM app_config WHERE key = 'retention.hourly_stats_days'
    `).get() as { value: string } | undefined;

    const autoCleanup = this.db.prepare(`
      SELECT value FROM app_config WHERE key = 'retention.auto_cleanup'
    `).get() as { value: string } | undefined;

    return {
      connectionLogsDays: parseInt(connectionLogsDays?.value || '7', 10),
      hourlyStatsDays: parseInt(hourlyStatsDays?.value || '30', 10),
      autoCleanup: autoCleanup?.value === '1',
    };
  }

  // Update retention configuration
  updateRetentionConfig(updates: {
    connectionLogsDays?: number;
    hourlyStatsDays?: number;
    autoCleanup?: boolean;
  }): DatabaseRetentionConfig {
    if (updates.connectionLogsDays !== undefined) {
      this.db.prepare(`
        INSERT INTO app_config (key, value) VALUES ('retention.connection_logs_days', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(updates.connectionLogsDays.toString());
    }

    if (updates.hourlyStatsDays !== undefined) {
      this.db.prepare(`
        INSERT INTO app_config (key, value) VALUES ('retention.hourly_stats_days', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(updates.hourlyStatsDays.toString());
    }

    if (updates.autoCleanup !== undefined) {
      this.db.prepare(`
        INSERT INTO app_config (key, value) VALUES ('retention.auto_cleanup', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(updates.autoCleanup ? '1' : '0');
    }

    return this.getRetentionConfig();
  }

  // Backend Management Methods

  // Create a new backend configuration
  createBackend(backend: { name: string; url: string; token?: string }): number {
    const stmt = this.db.prepare(`
      INSERT INTO backend_configs (name, url, token, enabled, is_active, listening)
      VALUES (?, ?, ?, 1, 0, 1)
    `);
    const result = stmt.run(backend.name, backend.url, backend.token || '');
    return Number(result.lastInsertRowid);
  }

  // Get all backend configurations
  getAllBackends(): BackendConfig[] {
    const stmt = this.db.prepare(`
      SELECT id, name, url, token, enabled, is_active, listening, created_at, updated_at
      FROM backend_configs
      ORDER BY created_at ASC
    `);
    return stmt.all() as BackendConfig[];
  }

  // Get a backend by ID
  getBackend(id: number): BackendConfig | undefined {
    const stmt = this.db.prepare(`
      SELECT id, name, url, token, enabled, is_active, listening, created_at, updated_at
      FROM backend_configs
      WHERE id = ?
    `);
    return stmt.get(id) as BackendConfig | undefined;
  }

  // Get the currently active backend
  getActiveBackend(): BackendConfig | undefined {
    const stmt = this.db.prepare(`
      SELECT id, name, url, token, enabled, is_active, listening, created_at, updated_at
      FROM backend_configs
      WHERE is_active = 1
      LIMIT 1
    `);
    return stmt.get() as BackendConfig | undefined;
  }

  // Get all backends that should be listening (collecting data)
  getListeningBackends(): BackendConfig[] {
    const stmt = this.db.prepare(`
      SELECT id, name, url, token, enabled, is_active, listening, created_at, updated_at
      FROM backend_configs
      WHERE listening = 1 AND enabled = 1
    `);
    return stmt.all() as BackendConfig[];
  }

  // Update a backend configuration
  updateBackend(id: number, updates: Partial<Omit<BackendConfig, 'id' | 'created_at'>>): void {
    const sets: string[] = [];
    const values: (string | number | boolean)[] = [];

    if (updates.name !== undefined) {
      sets.push('name = ?');
      values.push(updates.name);
    }
    if (updates.url !== undefined) {
      sets.push('url = ?');
      values.push(updates.url);
    }
    if (updates.token !== undefined) {
      sets.push('token = ?');
      values.push(updates.token);
    }
    if (updates.enabled !== undefined) {
      sets.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }
    if (updates.listening !== undefined) {
      sets.push('listening = ?');
      values.push(updates.listening ? 1 : 0);
    }
    if (updates.is_active !== undefined) {
      sets.push('is_active = ?');
      values.push(updates.is_active ? 1 : 0);
    }

    if (sets.length === 0) return;

    sets.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = this.db.prepare(`
      UPDATE backend_configs
      SET ${sets.join(', ')}
      WHERE id = ?
    `);
    stmt.run(...values);
  }

  // Set a backend as active (for display) - unsets all others
  setActiveBackend(id: number): void {
    this.db.exec('BEGIN TRANSACTION');
    try {
      // Unset all backends as active
      this.db.prepare(`UPDATE backend_configs SET is_active = 0`).run();
      // Set the specified backend as active
      this.db.prepare(`UPDATE backend_configs SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Set listening state for a backend (controls data collection)
  setBackendListening(id: number, listening: boolean): void {
    const stmt = this.db.prepare(`
      UPDATE backend_configs
      SET listening = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    stmt.run(listening ? 1 : 0, id);
  }

  // Delete a backend and all its associated data
  deleteBackend(id: number): void {
    // Due to ON DELETE CASCADE, all associated stats will be deleted automatically
    const stmt = this.db.prepare(`DELETE FROM backend_configs WHERE id = ?`);
    stmt.run(id);
  }

  // Delete all data for a specific backend
  deleteBackendData(id: number): void {
    this.db.exec('BEGIN TRANSACTION');
    try {
      this.db.prepare(`DELETE FROM domain_stats WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM ip_stats WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM proxy_stats WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM rule_stats WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM rule_proxy_map WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM rule_chain_traffic WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM rule_domain_traffic WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM rule_ip_traffic WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM country_stats WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM hourly_stats WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM connection_logs WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM minute_stats WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM minute_dim_stats WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM minute_country_stats WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM domain_proxy_stats WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM ip_proxy_stats WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM device_stats WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM device_domain_stats WHERE backend_id = ?`).run(id);
      this.db.prepare(`DELETE FROM device_ip_stats WHERE backend_id = ?`).run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Get total stats across all backends
  getGlobalSummary(): { totalConnections: number; totalUpload: number; totalDownload: number; uniqueDomains: number; uniqueIPs: number; backendCount: number } {
    // Calculate totals from ip_stats to include traffic with unknown domains
    const trafficStmt = this.db.prepare(`
      SELECT 
        COALESCE(SUM(total_connections), 0) as connections,
        COALESCE(SUM(total_upload), 0) as upload, 
        COALESCE(SUM(total_download), 0) as download
      FROM ip_stats
    `);
    const { connections, upload, download } = trafficStmt.get() as { 
      connections: number; 
      upload: number; 
      download: number;
    };

    const domainsStmt = this.db.prepare(`
      SELECT COUNT(DISTINCT domain) as count FROM domain_stats
    `);
    const uniqueDomains = (domainsStmt.get() as { count: number }).count;

    const ipsStmt = this.db.prepare(`
      SELECT COUNT(DISTINCT ip) as count FROM ip_stats
    `);
    const uniqueIPs = (ipsStmt.get() as { count: number }).count;

    const backendStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM backend_configs
    `);
    const backendCount = (backendStmt.get() as { count: number }).count;

    return {
      totalConnections: connections,
      totalUpload: upload,
      totalDownload: download,
      uniqueDomains,
      uniqueIPs,
      backendCount
    };
  }

  vacuum(): void {
    this.db.exec('VACUUM');
  }

  // Cleanup methods for data retention
  deleteOldMinuteStats(cutoff: string): number {
    const minuteCutoff = cutoff.slice(0, 16) + ':00';
    const stmt = this.db.prepare(`
      DELETE FROM minute_stats WHERE minute < ?
    `);
    this.db.prepare(`DELETE FROM minute_dim_stats WHERE minute < ?`).run(minuteCutoff);
    this.db.prepare(`DELETE FROM minute_country_stats WHERE minute < ?`).run(minuteCutoff);
    // Also clean old connection_logs if any remain from before migration
    this.db.prepare(`DELETE FROM connection_logs WHERE timestamp < ?`).run(cutoff);
    return stmt.run(minuteCutoff).changes;
  }

  // Keep old method name as alias for backward compatibility
  deleteOldConnectionLogs(cutoff: string): number {
    return this.deleteOldMinuteStats(cutoff);
  }

  deleteOldHourlyStats(cutoff: string): number {
    const stmt = this.db.prepare(`
      DELETE FROM hourly_stats WHERE hour < ?
    `);
    return stmt.run(cutoff).changes;
  }

  getCleanupStats(): {
    connectionLogsCount: number;
    hourlyStatsCount: number;
    oldestConnectionLog: string | null;
    oldestHourlyStat: string | null;
  } {
    const logsCountStmt = this.db.prepare('SELECT COUNT(*) as count FROM minute_stats');
    const hourlyCountStmt = this.db.prepare('SELECT COUNT(*) as count FROM hourly_stats');
    const oldestLogStmt = this.db.prepare('SELECT MIN(minute) as ts FROM minute_stats');
    const oldestHourlyStmt = this.db.prepare('SELECT MIN(hour) as hr FROM hourly_stats');

    return {
      connectionLogsCount: (logsCountStmt.get() as { count: number }).count,
      hourlyStatsCount: (hourlyCountStmt.get() as { count: number }).count,
      oldestConnectionLog: (oldestLogStmt.get() as { ts: string | null })?.ts || null,
      oldestHourlyStat: (oldestHourlyStmt.get() as { hr: string | null })?.hr || null,
    };
  }

  close() {
    this.db.close();
  }
}

export default StatsDatabase;
