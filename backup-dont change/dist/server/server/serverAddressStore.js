import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
export class ServerAddressStore {
    database;
    constructor(databasePath) {
        if (databasePath !== ":memory:")
            mkdirSync(path.dirname(databasePath), { recursive: true });
        this.database = new DatabaseSync(databasePath, { timeout: 5000 });
        this.database.exec("PRAGMA foreign_keys = ON");
        this.database.exec("PRAGMA journal_mode = WAL");
        this.database.exec("PRAGMA synchronous = NORMAL");
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS server_address_overrides (
        hostname TEXT PRIMARY KEY COLLATE NOCASE,
        in_band_ip TEXT NOT NULL,
        out_of_band_ip TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `);
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS topology_layout_positions (
        node_id TEXT PRIMARY KEY,
        x REAL NOT NULL,
        y REAL NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `);
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS topology_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `);
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS topology_catalog (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES topology_projects(id),
        name TEXT NOT NULL COLLATE NOCASE,
        source_type TEXT NOT NULL CHECK(source_type IN ('nvue', 'ports-csv')),
        snapshot_json TEXT,
        node_count INTEGER NOT NULL,
        link_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, name)
      ) STRICT
    `);
        this.database.exec("CREATE INDEX IF NOT EXISTS idx_topology_catalog_project_id ON topology_catalog(project_id)");
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS topology_layout_positions_v2 (
        topology_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(topology_id, node_id)
      ) STRICT
    `);
        this.database.exec(`
      INSERT OR IGNORE INTO topology_layout_positions_v2 (topology_id, node_id, x, y, updated_at)
      SELECT 'metta-roce', node_id, x, y, updated_at FROM topology_layout_positions
    `);
        this.database.exec("PRAGMA optimize");
    }
    all() {
        const rows = this.database
            .prepare("SELECT hostname, in_band_ip, out_of_band_ip, updated_at FROM server_address_overrides ORDER BY hostname")
            .all();
        return new Map(rows.map((row) => [row.hostname.toLowerCase(), {
                hostname: row.hostname,
                inBandIp: row.in_band_ip,
                outOfBandIp: row.out_of_band_ip,
                updatedAt: row.updated_at,
            }]));
    }
    upsert(hostname, inBandIp, outOfBandIp) {
        const updatedAt = new Date().toISOString();
        this.database.prepare(`
      INSERT INTO server_address_overrides (hostname, in_band_ip, out_of_band_ip, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(hostname) DO UPDATE SET
        in_band_ip = excluded.in_band_ip,
        out_of_band_ip = excluded.out_of_band_ip,
        updated_at = excluded.updated_at
    `).run(hostname, inBandIp, outOfBandIp, updatedAt);
        return { hostname, inBandIp, outOfBandIp, updatedAt };
    }
    delete(hostname) {
        this.database.prepare("DELETE FROM server_address_overrides WHERE hostname = ?").run(hostname);
    }
    ensureDefaultCatalog(nodeCount, linkCount) {
        const now = new Date().toISOString();
        this.database.prepare(`
      INSERT INTO topology_projects (id, name, created_at, updated_at)
      VALUES ('metta', 'Metta', ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(now, now);
        this.database.prepare(`
      INSERT INTO topology_catalog (id, project_id, name, source_type, snapshot_json, node_count, link_count, created_at, updated_at)
      VALUES ('metta-roce', 'metta', 'Metta RoCE网络', 'nvue', NULL, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET node_count = excluded.node_count, link_count = excluded.link_count, updated_at = excluded.updated_at
    `).run(nodeCount, linkCount, now, now);
    }
    listProjects() {
        const projects = this.database.prepare("SELECT id, name, created_at, updated_at FROM topology_projects ORDER BY created_at, name").all();
        const topologies = this.database.prepare(`
      SELECT id, project_id, name, source_type, snapshot_json, node_count, link_count, created_at, updated_at
      FROM topology_catalog ORDER BY created_at, name
    `).all();
        return projects.map((project) => ({
            id: project.id,
            name: project.name,
            createdAt: project.created_at,
            updatedAt: project.updated_at,
            topologies: topologies.filter((topology) => topology.project_id === project.id).map((topology) => ({
                id: topology.id,
                projectId: topology.project_id,
                name: topology.name,
                sourceType: topology.source_type,
                nodeCount: topology.node_count,
                linkCount: topology.link_count,
                createdAt: topology.created_at,
                updatedAt: topology.updated_at,
            })),
        }));
    }
    createProject(id, name) {
        const now = new Date().toISOString();
        this.database.prepare("INSERT INTO topology_projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, now, now);
    }
    renameProject(id, name) {
        const result = this.database.prepare("UPDATE topology_projects SET name = ?, updated_at = ? WHERE id = ?").run(name, new Date().toISOString(), id);
        return result.changes > 0;
    }
    saveImportedTopology(id, projectId, name, snapshot) {
        const now = new Date().toISOString();
        this.database.prepare(`
      INSERT INTO topology_catalog (id, project_id, name, source_type, snapshot_json, node_count, link_count, created_at, updated_at)
      VALUES (?, ?, ?, 'ports-csv', ?, ?, ?, ?, ?)
    `).run(id, projectId, name, JSON.stringify({ ...snapshot, layoutPositions: {} }), snapshot.nodes.length, snapshot.links.length, now, now);
    }
    renameTopology(projectId, topologyId, name) {
        const result = this.database.prepare("UPDATE topology_catalog SET name = ?, updated_at = ? WHERE id = ? AND project_id = ?").run(name, new Date().toISOString(), topologyId, projectId);
        return result.changes > 0;
    }
    importedTopology(projectId, topologyId) {
        const row = this.database.prepare(`
      SELECT snapshot_json FROM topology_catalog WHERE id = ? AND project_id = ? AND source_type = 'ports-csv'
    `).get(topologyId, projectId);
        return row?.snapshot_json ? JSON.parse(row.snapshot_json) : undefined;
    }
    topologySummary(projectId, topologyId) {
        return this.listProjects().find((project) => project.id === projectId)?.topologies.find((topology) => topology.id === topologyId);
    }
    layoutPositions(topologyId = "metta-roce") {
        const rows = this.database
            .prepare("SELECT node_id, x, y FROM topology_layout_positions_v2 WHERE topology_id = ? ORDER BY node_id")
            .all(topologyId);
        return Object.fromEntries(rows.map((row) => [row.node_id, { x: row.x, y: row.y }]));
    }
    saveLayout(positions, topologyId = "metta-roce") {
        const statement = this.database.prepare(`
      INSERT INTO topology_layout_positions_v2 (topology_id, node_id, x, y, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(topology_id, node_id) DO UPDATE SET
        x = excluded.x,
        y = excluded.y,
        updated_at = excluded.updated_at
    `);
        const updatedAt = new Date().toISOString();
        this.database.exec("BEGIN IMMEDIATE");
        try {
            for (const [nodeId, position] of Object.entries(positions)) {
                statement.run(topologyId, nodeId, position.x, position.y, updatedAt);
            }
            this.database.exec("COMMIT");
        }
        catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
    }
    close() {
        this.database.close();
    }
}
//# sourceMappingURL=serverAddressStore.js.map