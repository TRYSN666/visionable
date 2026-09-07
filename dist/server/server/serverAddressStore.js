import { randomUUID } from "node:crypto";
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
      CREATE TABLE IF NOT EXISTS topology_installed_interfaces (
        topology_id TEXT NOT NULL REFERENCES topology_catalog(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        interface_name TEXT NOT NULL COLLATE NOCASE,
        logical INTEGER NOT NULL CHECK(logical IN (0, 1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY(topology_id, device_id, interface_name)
      ) STRICT
    `);
        this.database.exec(`
      INSERT OR IGNORE INTO topology_layout_positions_v2 (topology_id, node_id, x, y, updated_at)
      SELECT 'metta-roce', node_id, x, y, updated_at FROM topology_layout_positions
    `);
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS forwarding_snapshots (
        id TEXT PRIMARY KEY,
        topology_id TEXT NOT NULL REFERENCES topology_catalog(id) ON DELETE CASCADE,
        template_version TEXT NOT NULL,
        batch_name TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        note TEXT,
        topology_fingerprint TEXT NOT NULL,
        is_default INTEGER NOT NULL CHECK(is_default IN (0, 1)),
        counts_json TEXT NOT NULL,
        UNIQUE(topology_id, id)
      ) STRICT
    `);
        this.database.exec("CREATE INDEX IF NOT EXISTS idx_forwarding_snapshots_topology ON forwarding_snapshots(topology_id, imported_at DESC)");
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS forwarding_interfaces (
        topology_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        row_number INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        interface_name TEXT NOT NULL,
        interface_type TEXT NOT NULL,
        forwarding_mode TEXT NOT NULL,
        vrf TEXT NOT NULL,
        vlan INTEGER,
        allowed_vlans_json TEXT NOT NULL,
        bridge TEXT,
        mac TEXT,
        status TEXT NOT NULL,
        PRIMARY KEY(topology_id, snapshot_id, row_number),
        FOREIGN KEY(topology_id, snapshot_id) REFERENCES forwarding_snapshots(topology_id, id) ON DELETE CASCADE
      ) STRICT
    `);
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS forwarding_lag_members (
        topology_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        row_number INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        aggregate_interface TEXT NOT NULL,
        member_interface TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY(topology_id, snapshot_id, row_number),
        FOREIGN KEY(topology_id, snapshot_id) REFERENCES forwarding_snapshots(topology_id, id) ON DELETE CASCADE
      ) STRICT
    `);
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS forwarding_routes (
        topology_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        row_number INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        vrf TEXT NOT NULL,
        destination_cidr TEXT NOT NULL,
        action TEXT NOT NULL,
        next_hop TEXT,
        output_interface TEXT,
        ecmp_group TEXT,
        vni INTEGER,
        remote_vtep TEXT,
        PRIMARY KEY(topology_id, snapshot_id, row_number),
        FOREIGN KEY(topology_id, snapshot_id) REFERENCES forwarding_snapshots(topology_id, id) ON DELETE CASCADE
      ) STRICT
    `);
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS forwarding_arp_entries (
        topology_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        row_number INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        vrf TEXT NOT NULL,
        ip TEXT NOT NULL,
        mac TEXT NOT NULL,
        interface_name TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY(topology_id, snapshot_id, row_number),
        FOREIGN KEY(topology_id, snapshot_id) REFERENCES forwarding_snapshots(topology_id, id) ON DELETE CASCADE
      ) STRICT
    `);
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS forwarding_mac_entries (
        topology_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        row_number INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        vlan INTEGER NOT NULL,
        mac TEXT NOT NULL,
        action TEXT NOT NULL,
        output_interface TEXT,
        vni INTEGER,
        remote_vtep TEXT,
        PRIMARY KEY(topology_id, snapshot_id, row_number),
        FOREIGN KEY(topology_id, snapshot_id) REFERENCES forwarding_snapshots(topology_id, id) ON DELETE CASCADE
      ) STRICT
    `);
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS forwarding_vxlan_entries (
        topology_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        row_number INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        vni INTEGER NOT NULL,
        mode TEXT NOT NULL,
        local_vtep TEXT NOT NULL,
        vlan INTEGER,
        tenant_vrf TEXT,
        underlay_vrf TEXT NOT NULL,
        udp_destination_port INTEGER NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY(topology_id, snapshot_id, row_number),
        FOREIGN KEY(topology_id, snapshot_id) REFERENCES forwarding_snapshots(topology_id, id) ON DELETE CASCADE
      ) STRICT
    `);
        for (const table of ["forwarding_interfaces", "forwarding_lag_members", "forwarding_routes", "forwarding_arp_entries", "forwarding_mac_entries", "forwarding_vxlan_entries"]) {
            const columns = new Set(this.database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
            if (!columns.has("source_file"))
                this.database.exec(`ALTER TABLE ${table} ADD COLUMN source_file TEXT`);
            if (!columns.has("source_row"))
                this.database.exec(`ALTER TABLE ${table} ADD COLUMN source_row INTEGER`);
            this.database.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_snapshot_device ON ${table}(topology_id, snapshot_id, device_id)`);
        }
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
    installedTopologyInterfaces(topologyId) {
        const rows = this.database.prepare(`
      SELECT device_id, interface_name, logical
      FROM topology_installed_interfaces
      WHERE topology_id = ?
      ORDER BY device_id, interface_name
    `).all(topologyId);
        return rows.map((row) => ({ deviceId: row.device_id, interfaceName: row.interface_name, logical: row.logical === 1 }));
    }
    saveForwardingSnapshot(topologyId, topologyFingerprint, data, installedInterfaces = []) {
        const id = `forwarding-${randomUUID()}`;
        const importedAt = new Date().toISOString();
        const counts = {
            interfaces: data.interfaces.length,
            lagMembers: data.lagMembers.length,
            routes: data.routes.length,
            arpEntries: data.arpEntries.length,
            macEntries: data.macEntries.length,
            vxlanEntries: data.vxlanEntries.length,
        };
        const insertInterface = this.database.prepare(`
      INSERT INTO forwarding_interfaces
        (topology_id, snapshot_id, row_number, device_id, device_name, interface_name, interface_type, forwarding_mode, vrf, vlan, allowed_vlans_json, bridge, mac, status, source_file, source_row)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const insertLag = this.database.prepare(`
      INSERT INTO forwarding_lag_members
        (topology_id, snapshot_id, row_number, device_id, device_name, aggregate_interface, member_interface, status, source_file, source_row)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const insertRoute = this.database.prepare(`
      INSERT INTO forwarding_routes
        (topology_id, snapshot_id, row_number, device_id, device_name, vrf, destination_cidr, action, next_hop, output_interface, ecmp_group, vni, remote_vtep, source_file, source_row)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const insertArp = this.database.prepare(`
      INSERT INTO forwarding_arp_entries
        (topology_id, snapshot_id, row_number, device_id, device_name, vrf, ip, mac, interface_name, status, source_file, source_row)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const insertMac = this.database.prepare(`
      INSERT INTO forwarding_mac_entries
        (topology_id, snapshot_id, row_number, device_id, device_name, vlan, mac, action, output_interface, vni, remote_vtep, source_file, source_row)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const insertVxlan = this.database.prepare(`
      INSERT INTO forwarding_vxlan_entries
        (topology_id, snapshot_id, row_number, device_id, device_name, vni, mode, local_vtep, vlan, tenant_vrf, underlay_vrf, udp_destination_port, status, source_file, source_row)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const installInterface = this.database.prepare(`
      INSERT INTO topology_installed_interfaces
        (topology_id, device_id, interface_name, logical, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(topology_id, device_id, interface_name) DO UPDATE SET
        logical = excluded.logical
    `);
        this.database.exec("BEGIN IMMEDIATE");
        try {
            for (const item of installedInterfaces)
                installInterface.run(topologyId, item.deviceId, item.interfaceName, item.logical ? 1 : 0, importedAt);
            this.database.prepare("UPDATE forwarding_snapshots SET is_default = 0 WHERE topology_id = ?").run(topologyId);
            this.database.prepare(`
        INSERT INTO forwarding_snapshots
          (id, topology_id, template_version, batch_name, collected_at, imported_at, note, topology_fingerprint, is_default, counts_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(id, topologyId, data.metadata.templateVersion, data.metadata.batchName, data.metadata.collectedAt, importedAt, data.metadata.note ?? null, topologyFingerprint, JSON.stringify(counts));
            for (const [index, item] of data.interfaces.entries())
                insertInterface.run(topologyId, id, index + 1, item.deviceId, item.deviceName, item.interfaceName, item.interfaceType, item.forwardingMode, item.vrf, item.vlan ?? null, JSON.stringify(item.allowedVlans), item.bridge ?? null, item.mac ?? null, item.status, item.sourceFile ?? null, item.row);
            for (const [index, item] of data.lagMembers.entries())
                insertLag.run(topologyId, id, index + 1, item.deviceId, item.deviceName, item.aggregateInterface, item.memberInterface, item.status, item.sourceFile ?? null, item.row);
            for (const [index, item] of data.routes.entries())
                insertRoute.run(topologyId, id, index + 1, item.deviceId, item.deviceName, item.vrf, item.destinationCidr, item.action, item.nextHop ?? null, item.outputInterface ?? null, item.ecmpGroup ?? null, item.vni ?? null, item.remoteVtep ?? null, item.sourceFile ?? null, item.row);
            for (const [index, item] of data.arpEntries.entries())
                insertArp.run(topologyId, id, index + 1, item.deviceId, item.deviceName, item.vrf, item.ip, item.mac, item.interfaceName, item.status, item.sourceFile ?? null, item.row);
            for (const [index, item] of data.macEntries.entries())
                insertMac.run(topologyId, id, index + 1, item.deviceId, item.deviceName, item.vlan, item.mac, item.action, item.outputInterface ?? null, item.vni ?? null, item.remoteVtep ?? null, item.sourceFile ?? null, item.row);
            for (const [index, item] of data.vxlanEntries.entries())
                insertVxlan.run(topologyId, id, index + 1, item.deviceId, item.deviceName, item.vni, item.mode, item.localVtep, item.vlan ?? null, item.tenantVrf ?? null, item.underlayVrf, item.udpDestinationPort, item.status, item.sourceFile ?? null, item.row);
            const stale = this.database.prepare(`
        SELECT id FROM forwarding_snapshots WHERE topology_id = ? ORDER BY imported_at DESC, rowid DESC LIMIT -1 OFFSET 5
      `).all(topologyId);
            const remove = this.database.prepare("DELETE FROM forwarding_snapshots WHERE topology_id = ? AND id = ?");
            for (const item of stale)
                remove.run(topologyId, item.id);
            this.database.exec("COMMIT");
        }
        catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
        return this.listForwardingSnapshots(topologyId, topologyFingerprint).find((item) => item.id === id);
    }
    listForwardingSnapshots(topologyId, currentFingerprint) {
        const rows = this.database.prepare(`
      SELECT id, topology_id, template_version, batch_name, collected_at, imported_at, note, topology_fingerprint, is_default, counts_json
      FROM forwarding_snapshots WHERE topology_id = ? ORDER BY imported_at DESC, rowid DESC LIMIT 5
    `).all(topologyId);
        return rows.map((row) => {
            const compatible = row.topology_fingerprint === currentFingerprint;
            return {
                id: row.id,
                topologyId: row.topology_id,
                batchName: row.batch_name,
                templateVersion: row.template_version,
                collectedAt: row.collected_at,
                importedAt: row.imported_at,
                note: row.note ?? undefined,
                isDefault: row.is_default === 1,
                compatible,
                compatibilityReason: compatible ? undefined : "拓扑设备、接口或物理链路结构已变化，请重新导入转发表",
                counts: JSON.parse(row.counts_json),
            };
        });
    }
    forwardingSnapshot(topologyId, snapshotId) {
        const row = this.database.prepare(`
      SELECT id, topology_id, template_version, batch_name, collected_at, imported_at, note, topology_fingerprint, is_default, counts_json
      FROM forwarding_snapshots WHERE topology_id = ? AND id = ?
    `).get(topologyId, snapshotId);
        if (!row)
            return undefined;
        const interfaces = this.database.prepare(`SELECT * FROM forwarding_interfaces WHERE topology_id = ? AND snapshot_id = ? ORDER BY row_number`).all(topologyId, snapshotId);
        const lagMembers = this.database.prepare(`SELECT * FROM forwarding_lag_members WHERE topology_id = ? AND snapshot_id = ? ORDER BY row_number`).all(topologyId, snapshotId);
        const routes = this.database.prepare(`SELECT * FROM forwarding_routes WHERE topology_id = ? AND snapshot_id = ? ORDER BY row_number`).all(topologyId, snapshotId);
        const arpEntries = this.database.prepare(`SELECT * FROM forwarding_arp_entries WHERE topology_id = ? AND snapshot_id = ? ORDER BY row_number`).all(topologyId, snapshotId);
        const macEntries = this.database.prepare(`SELECT * FROM forwarding_mac_entries WHERE topology_id = ? AND snapshot_id = ? ORDER BY row_number`).all(topologyId, snapshotId);
        const vxlanEntries = this.database.prepare(`SELECT * FROM forwarding_vxlan_entries WHERE topology_id = ? AND snapshot_id = ? ORDER BY row_number`).all(topologyId, snapshotId);
        return {
            metadata: { templateVersion: row.template_version, batchName: row.batch_name, collectedAt: row.collected_at, note: row.note ?? undefined },
            interfaces: interfaces.map((item) => ({ row: (item.source_row ?? item.row_number), sourceFile: item.source_file == null ? undefined : item.source_file, deviceId: item.device_id, deviceName: item.device_name, interfaceName: item.interface_name, interfaceType: item.interface_type, forwardingMode: item.forwarding_mode, vrf: item.vrf, vlan: item.vlan == null ? undefined : item.vlan, allowedVlans: JSON.parse(item.allowed_vlans_json), bridge: item.bridge == null ? undefined : item.bridge, mac: item.mac == null ? undefined : item.mac, status: item.status })),
            lagMembers: lagMembers.map((item) => ({ row: (item.source_row ?? item.row_number), sourceFile: item.source_file == null ? undefined : item.source_file, deviceId: item.device_id, deviceName: item.device_name, aggregateInterface: item.aggregate_interface, memberInterface: item.member_interface, status: item.status })),
            routes: routes.map((item) => ({ row: (item.source_row ?? item.row_number), sourceFile: item.source_file == null ? undefined : item.source_file, deviceId: item.device_id, deviceName: item.device_name, vrf: item.vrf, destinationCidr: item.destination_cidr, action: item.action, nextHop: item.next_hop == null ? undefined : item.next_hop, outputInterface: item.output_interface == null ? undefined : item.output_interface, ecmpGroup: item.ecmp_group == null ? undefined : item.ecmp_group, vni: item.vni == null ? undefined : item.vni, remoteVtep: item.remote_vtep == null ? undefined : item.remote_vtep })),
            arpEntries: arpEntries.map((item) => ({ row: (item.source_row ?? item.row_number), sourceFile: item.source_file == null ? undefined : item.source_file, deviceId: item.device_id, deviceName: item.device_name, vrf: item.vrf, ip: item.ip, mac: item.mac, interfaceName: item.interface_name, status: item.status })),
            macEntries: macEntries.map((item) => ({ row: (item.source_row ?? item.row_number), sourceFile: item.source_file == null ? undefined : item.source_file, deviceId: item.device_id, deviceName: item.device_name, vlan: item.vlan, mac: item.mac, action: item.action, outputInterface: item.output_interface == null ? undefined : item.output_interface, vni: item.vni == null ? undefined : item.vni, remoteVtep: item.remote_vtep == null ? undefined : item.remote_vtep })),
            vxlanEntries: vxlanEntries.map((item) => ({ row: (item.source_row ?? item.row_number), sourceFile: item.source_file == null ? undefined : item.source_file, deviceId: item.device_id, deviceName: item.device_name, vni: item.vni, mode: item.mode, localVtep: item.local_vtep, vlan: item.vlan == null ? undefined : item.vlan, tenantVrf: item.tenant_vrf == null ? undefined : item.tenant_vrf, underlayVrf: item.underlay_vrf, udpDestinationPort: item.udp_destination_port, status: item.status })),
        };
    }
    forwardingSnapshotFingerprint(topologyId, snapshotId) {
        const row = this.database.prepare("SELECT topology_fingerprint FROM forwarding_snapshots WHERE topology_id = ? AND id = ?").get(topologyId, snapshotId);
        return row?.topology_fingerprint;
    }
    close() {
        this.database.close();
    }
}
//# sourceMappingURL=serverAddressStore.js.map