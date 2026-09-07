import { randomUUID } from "node:crypto";
import type { ForwardingSnapshotSummary, ForwardingTraceRequest, ForwardingTraceResult } from "../shared/forwarding.js";
import type { InterfaceRecord, TopologyPosition, TopologyProject, TopologySnapshot } from "../shared/topology.js";
import { traceForwarding } from "./forwardingEngine.js";
import { parseForwardingWorkbook, parseForwardingWorkbooks, type ForwardingWorkbookInput } from "./forwardingWorkbookParser.js";
import { applyServerInventory, loadServerInventory } from "./inventory.js";
import { parseConfigDirectory } from "./parser.js";
import { inferImportedRole, parsePortsCsv, parsePortsXlsx } from "./portsCsvParser.js";
import { ServerAddressStore, type InstalledTopologyInterface } from "./serverAddressStore.js";
import { topologyStructureFingerprint } from "./topologyFingerprint.js";

export class ServerNodeNotFoundError extends Error {}
export class InvalidLayoutNodeError extends Error {}
export class CatalogNotFoundError extends Error {}
export class ForwardingSnapshotNotFoundError extends Error {}
export class ForwardingSnapshotIncompatibleError extends Error {}

function normalizeImportedSnapshot(snapshot: TopologySnapshot): TopologySnapshot {
  if (snapshot.sourceType !== "ports-csv") return snapshot;
  const nodes = snapshot.nodes.map((node) => {
    const legacyInterfaces = node.interfaces as Array<InterfaceRecord & { lid?: string }>;
    const lids = [...new Set([
      ...(node.lids ?? []),
      ...legacyInterfaces.map((item) => item.lid).filter((lid): lid is string => Boolean(lid)),
    ])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const interfaces = legacyInterfaces.map((item): InterfaceRecord => ({
      name: item.name,
      addresses: item.addresses,
      description: item.description,
      logical: item.logical,
      peers: item.peers,
    }));
    const role = inferImportedRole(node.hostname);
    const kind: "external" | "configured" = role === "ENDPOINT" || role === "SERVER" ? "external" : "configured";
    const endpointType = role === "ENDPOINT" ? "GPU" : role === "SERVER" ? "服务器" : undefined;
    return { ...node, kind, role, endpointType, lids: lids.length > 0 ? lids : undefined, interfaces };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const internalLinks = snapshot.links.filter((link) => nodeById.get(link.source)?.kind === "configured" && nodeById.get(link.target)?.kind === "configured").length;
  return {
    ...snapshot,
    nodes,
    warnings: snapshot.warnings.filter((warning) => warning.code !== "IMPORT_LID_CONFLICT"),
    stats: {
      ...snapshot.stats,
      configuredDevices: nodes.filter((node) => node.kind === "configured").length,
      externalDevices: nodes.filter((node) => node.kind === "external").length,
      internalLinks,
      externalLinks: snapshot.links.length - internalLinks,
    },
  };
}

function interfaceInstallations(data: import("../shared/forwarding.js").ForwardingSnapshotData): InstalledTopologyInterface[] {
  const aggregates = new Set(data.lagMembers.map((item) => `${item.deviceId}\0${item.aggregateInterface.toLowerCase()}`));
  const byKey = new Map<string, InstalledTopologyInterface>();
  const add = (deviceId: string, interfaceName: string | undefined, logical = false) => {
    if (!interfaceName) return;
    const key = `${deviceId}\0${interfaceName.toLowerCase()}`;
    const current = byKey.get(key);
    byKey.set(key, { deviceId, interfaceName: current?.interfaceName ?? interfaceName, logical: current?.logical === true || logical });
  };
  for (const item of data.interfaces) add(item.deviceId, item.interfaceName, item.interfaceType !== "physical");
  for (const item of data.lagMembers) {
    add(item.deviceId, item.aggregateInterface, true);
    add(item.deviceId, item.memberInterface, false);
  }
  for (const item of data.routes) add(item.deviceId, item.outputInterface, aggregates.has(`${item.deviceId}\0${item.outputInterface?.toLowerCase()}`));
  for (const item of data.arpEntries) add(item.deviceId, item.interfaceName, aggregates.has(`${item.deviceId}\0${item.interfaceName.toLowerCase()}`));
  for (const item of data.macEntries) add(item.deviceId, item.outputInterface, aggregates.has(`${item.deviceId}\0${item.outputInterface?.toLowerCase()}`));
  return [...byKey.values()];
}

function applyInstalledInterfaces(snapshot: TopologySnapshot, installed: InstalledTopologyInterface[]): TopologySnapshot {
  if (installed.length === 0) return snapshot;
  const requested = new Map<string, InstalledTopologyInterface[]>();
  for (const item of installed) requested.set(item.deviceId, [...(requested.get(item.deviceId) ?? []), item]);
  let added = 0;
  const nodes = snapshot.nodes.map((node) => {
    const additions = requested.get(node.id);
    if (!additions) return node;
    const existing = new Set(node.interfaces.map((item) => item.name.toLowerCase()));
    const interfaces = [...node.interfaces];
    for (const item of additions) {
      if (existing.has(item.interfaceName.toLowerCase())) continue;
      const peers = snapshot.links.flatMap((link) => {
        if (link.source === node.id && link.sourceInterface.toLowerCase() === item.interfaceName.toLowerCase()) {
          const peer = snapshot.nodes.find((candidate) => candidate.id === link.target);
          return [{ device: peer?.hostname ?? link.target, interface: link.targetInterface, bandwidth: link.bandwidth }];
        }
        if (link.target === node.id && link.targetInterface.toLowerCase() === item.interfaceName.toLowerCase()) {
          const peer = snapshot.nodes.find((candidate) => candidate.id === link.source);
          return [{ device: peer?.hostname ?? link.source, interface: link.sourceInterface, bandwidth: link.bandwidth }];
        }
        return [];
      });
      interfaces.push({ name: item.interfaceName, addresses: [], logical: item.logical || undefined, peers });
      existing.add(item.interfaceName.toLowerCase());
      added += 1;
    }
    return interfaces.length === node.interfaces.length ? node : { ...node, interfaces };
  });
  if (added === 0) return snapshot;
  return { ...snapshot, nodes, stats: { ...snapshot.stats, usedInterfaces: snapshot.stats.usedInterfaces + added } };
}

export class TopologyStore {
  readonly configDir: string;
  private snapshot?: TopologySnapshot;
  private inFlight?: Promise<TopologySnapshot>;
  private lastError?: string;

  constructor(configDir: string, private readonly addressStore = new ServerAddressStore(":memory:")) {
    this.configDir = configDir;
  }

  get current(): TopologySnapshot | undefined {
    return this.snapshot;
  }

  get ready(): boolean {
    return Boolean(this.snapshot);
  }

  get error(): string | undefined {
    return this.lastError;
  }

  refresh(): Promise<TopologySnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = Promise.all([parseConfigDirectory(this.configDir), loadServerInventory(this.configDir)])
      .then(([baseSnapshot, inventory]) => {
        const enrichedSnapshot = applyServerInventory(baseSnapshot, inventory, this.addressStore.all());
        const validLayoutIds = new Set([
          ...enrichedSnapshot.nodes.map((node) => node.id),
          ...enrichedSnapshot.clusters.map((cluster) => cluster.id),
        ]);
        const layoutPositions = Object.fromEntries(
          Object.entries(this.addressStore.layoutPositions("metta-roce")).filter(([id]) => validLayoutIds.has(id)),
        );
        const snapshot = applyInstalledInterfaces({ ...enrichedSnapshot, layoutPositions }, this.addressStore.installedTopologyInterfaces("metta-roce"));
        this.addressStore.ensureDefaultCatalog(snapshot.nodes.length, snapshot.links.length);
        this.snapshot = snapshot;
        this.lastError = undefined;
        return snapshot;
      })
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : "无法刷新拓扑";
        throw error;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  async updateServerAddresses(hostname: string, inBandIp: string, outOfBandIp: string): Promise<TopologySnapshot> {
    if (this.inFlight) await this.inFlight;
    const node = this.snapshot?.nodes.find((item) => item.hostname.toLowerCase() === hostname.toLowerCase());
    if (!node || node.kind !== "external" || node.endpointType !== "GPU") {
      throw new ServerNodeNotFoundError(`未找到 GPU 服务器 ${hostname}`);
    }
    this.addressStore.upsert(node.hostname, inBandIp, outOfBandIp);
    return this.refresh();
  }

  async resetServerAddresses(hostname: string): Promise<TopologySnapshot> {
    if (this.inFlight) await this.inFlight;
    const node = this.snapshot?.nodes.find((item) => item.hostname.toLowerCase() === hostname.toLowerCase());
    if (!node || node.kind !== "external" || node.endpointType !== "GPU") {
      throw new ServerNodeNotFoundError(`未找到 GPU 服务器 ${hostname}`);
    }
    this.addressStore.delete(node.hostname);
    return this.refresh();
  }

  async saveLayout(positions: Record<string, TopologyPosition>): Promise<TopologySnapshot> {
    if (this.inFlight) await this.inFlight;
    if (!this.snapshot) throw new Error("拓扑尚未加载");
    const validIds = new Set([
      ...this.snapshot.nodes.map((node) => node.id),
      ...this.snapshot.clusters.map((cluster) => cluster.id),
    ]);
    const invalidId = Object.keys(positions).find((id) => !validIds.has(id));
    if (invalidId) throw new InvalidLayoutNodeError(`布局中包含未知节点 ${invalidId}`);
    this.addressStore.saveLayout(positions, "metta-roce");
    this.snapshot = {
      ...this.snapshot,
      revision: `${this.snapshot.revision}:layout:${Date.now().toString(36)}`,
      layoutPositions: { ...this.snapshot.layoutPositions, ...positions },
    };
    return this.snapshot;
  }

  projects(): TopologyProject[] {
    if (this.snapshot) this.addressStore.ensureDefaultCatalog(this.snapshot.nodes.length, this.snapshot.links.length);
    return this.addressStore.listProjects();
  }

  createProject(name: string): TopologyProject {
    const id = `project-${randomUUID()}`;
    this.addressStore.createProject(id, name);
    return this.projects().find((project) => project.id === id)!;
  }

  renameProject(projectId: string, name: string): TopologyProject {
    if (!this.addressStore.renameProject(projectId, name)) throw new CatalogNotFoundError("项目不存在");
    return this.projects().find((project) => project.id === projectId)!;
  }

  renameTopology(projectId: string, topologyId: string, name: string): TopologyProject {
    if (!this.addressStore.renameTopology(projectId, topologyId, name)) throw new CatalogNotFoundError("拓扑不存在");
    return this.projects().find((project) => project.id === projectId)!;
  }

  async importTopology(projectId: string, name: string, fileContent: string | Buffer, sourceFile: string, preferredId?: string): Promise<{ id: string; snapshot: TopologySnapshot }> {
    if (!this.projects().some((project) => project.id === projectId)) throw new CatalogNotFoundError("项目不存在");
    const snapshot = sourceFile.toLowerCase().endsWith(".xlsx")
      ? await parsePortsXlsx(Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent, "base64"), sourceFile)
      : parsePortsCsv(Buffer.isBuffer(fileContent) ? fileContent.toString("utf8") : fileContent, sourceFile);
    const id = preferredId ?? `topology-${randomUUID()}`;
    this.addressStore.saveImportedTopology(id, projectId, name, snapshot);
    return { id, snapshot: this.topology(projectId, id) };
  }

  topology(projectId: string, topologyId: string): TopologySnapshot {
    const summary = this.addressStore.topologySummary(projectId, topologyId);
    if (!summary) throw new CatalogNotFoundError("拓扑不存在");
    if (summary.sourceType === "nvue") {
      if (!this.snapshot) throw new Error("拓扑尚未加载");
      return applyInstalledInterfaces(this.snapshot, this.addressStore.installedTopologyInterfaces(topologyId));
    }
    const stored = this.addressStore.importedTopology(projectId, topologyId);
    if (!stored) throw new CatalogNotFoundError("拓扑数据不存在");
    const validIds = new Set([...stored.nodes.map((node) => node.id), ...stored.clusters.map((cluster) => cluster.id)]);
    const layoutPositions = Object.fromEntries(
      Object.entries(this.addressStore.layoutPositions(topologyId)).filter(([id]) => validIds.has(id)),
    );
    return applyInstalledInterfaces(normalizeImportedSnapshot({ ...stored, layoutPositions }), this.addressStore.installedTopologyInterfaces(topologyId));
  }

  async saveTopologyLayout(projectId: string, topologyId: string, positions: Record<string, TopologyPosition>): Promise<TopologySnapshot> {
    if (topologyId === "metta-roce") return this.saveLayout(positions);
    const snapshot = this.topology(projectId, topologyId);
    const validIds = new Set([...snapshot.nodes.map((node) => node.id), ...snapshot.clusters.map((cluster) => cluster.id)]);
    const invalidId = Object.keys(positions).find((id) => !validIds.has(id));
    if (invalidId) throw new InvalidLayoutNodeError(`布局中包含未知节点 ${invalidId}`);
    this.addressStore.saveLayout(positions, topologyId);
    return {
      ...snapshot,
      revision: `${snapshot.revision}:layout:${Date.now().toString(36)}`,
      layoutPositions: { ...snapshot.layoutPositions, ...positions },
    };
  }

  async importForwardingSnapshot(projectId: string, topologyId: string, xlsxBytes: Buffer): Promise<ForwardingSnapshotSummary> {
    const topology = this.topology(projectId, topologyId);
    const data = await parseForwardingWorkbook(xlsxBytes, topology);
    const installations = interfaceInstallations(data);
    const updatedTopology = applyInstalledInterfaces(topology, installations);
    const summary = this.addressStore.saveForwardingSnapshot(topologyId, topologyStructureFingerprint(updatedTopology), data, installations);
    if (topologyId === "metta-roce") this.snapshot = updatedTopology;
    return summary;
  }

  async importForwardingSnapshotBatch(projectId: string, topologyId: string, workbooks: ForwardingWorkbookInput[]): Promise<ForwardingSnapshotSummary> {
    const topology = this.topology(projectId, topologyId);
    const data = await parseForwardingWorkbooks(workbooks, topology);
    const installations = interfaceInstallations(data);
    const updatedTopology = applyInstalledInterfaces(topology, installations);
    const summary = this.addressStore.saveForwardingSnapshot(topologyId, topologyStructureFingerprint(updatedTopology), data, installations);
    if (topologyId === "metta-roce") this.snapshot = updatedTopology;
    return summary;
  }

  forwardingSnapshots(projectId: string, topologyId: string): ForwardingSnapshotSummary[] {
    const topology = this.topology(projectId, topologyId);
    return this.addressStore.listForwardingSnapshots(topologyId, topologyStructureFingerprint(topology));
  }

  forwardingSnapshotData(projectId: string, topologyId: string, snapshotId: string): import("../shared/forwarding.js").ForwardingSnapshotData {
    this.topology(projectId, topologyId);
    const data = this.addressStore.forwardingSnapshot(topologyId, snapshotId);
    if (!data) throw new ForwardingSnapshotNotFoundError("转发表快照不存在或不属于当前拓扑");
    return data;
  }

  traceForwarding(projectId: string, topologyId: string, snapshotId: string, request: ForwardingTraceRequest): ForwardingTraceResult {
    const topology = this.topology(projectId, topologyId);
    const currentFingerprint = topologyStructureFingerprint(topology);
    const snapshotFingerprint = this.addressStore.forwardingSnapshotFingerprint(topologyId, snapshotId);
    if (!snapshotFingerprint) throw new ForwardingSnapshotNotFoundError("转发表快照不存在或不属于当前拓扑");
    if (snapshotFingerprint !== currentFingerprint) throw new ForwardingSnapshotIncompatibleError("拓扑结构已变化，该转发表快照不能再用于仿真");
    const data = this.addressStore.forwardingSnapshot(topologyId, snapshotId);
    if (!data) throw new ForwardingSnapshotNotFoundError("转发表快照不存在或不属于当前拓扑");
    return traceForwarding(topologyId, snapshotId, topology, data, request);
  }
}
