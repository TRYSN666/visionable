import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { TopologyStore } from "../server/store";
import { ServerAddressStore } from "../server/serverAddressStore";

const tempDirectories: string[] = [];

async function fixtureDirectory(): Promise<string> {
  const directory = path.join(tmpdir(), `network-topology-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  tempDirectories.push(directory);
  await writeFile(path.join(directory, "switch.md"), `
nv set interface eth0 description Link_MDC-DH1E-J25-POD1-GPU-001_eth0_BW1G
nv set interface eth0 ip address 10.0.0.1/24
nv set system hostname MDC-DH1E-G13-39U-CSW-001
nv set service snmp-server readonly-community must-not-leak access any
`, "utf8");
  await writeFile(path.join(directory, "服务器SN核对.csv"), `主机名,别名,带外地址,带内地址,是否一致,飞书云文档SN
MDC-DH1E-J25-POD1-GPU-001,hgx001,192.168.1.1,10.10.1.1,一致,SN001
备用gpu服务器,,,,,
`, "utf8");
  await writeFile(path.join(directory, "broken.md"), "not a config", "utf8");
  return directory;
}

async function forwardingFixtureDirectory(): Promise<string> {
  const directory = path.join(tmpdir(), `network-topology-forwarding-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  tempDirectories.push(directory);
  await Promise.all([
    writeFile(path.join(directory, "switch-a.md"), `
nv set interface eth0 description Link_MDC-DH1E-G13-39U-CSW-002_eth0_BW1G
nv set interface eth0 ip address 10.0.0.1/32
nv set system hostname MDC-DH1E-G13-39U-CSW-001
`, "utf8"),
    writeFile(path.join(directory, "switch-b.md"), `
nv set interface eth0 description Link_MDC-DH1E-G13-39U-CSW-001_eth0_BW1G
nv set interface eth0 ip address 10.0.0.2/32
nv set system hostname MDC-DH1E-G13-39U-CSW-002
`, "utf8"),
  ]);
  return directory;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function setWorkbookCell(files: Record<string, Uint8Array>, sheet: number, reference: string, value: string): void {
  const fileName = `xl/worksheets/sheet${sheet}.xml`;
  const xml = strFromU8(files[fileName]);
  const cellPattern = new RegExp(`<x:c r="${reference}"[^>]*?(?:\\s*/>|>.*?</x:c>)`);
  const currentCell = cellPattern.exec(xml)?.[0];
  if (!currentCell) throw new Error(`测试工作簿中缺少单元格 ${reference}`);
  const style = /\bs="([^"]+)"/.exec(currentCell)?.[1];
  const replacement = `<x:c r="${reference}"${style ? ` s="${style}"` : ""} t="str"><x:v>${escapeXml(value)}</x:v></x:c>`;
  files[fileName] = strToU8(xml.replace(cellPattern, replacement));
}

async function directRouteWorkbook(): Promise<Buffer> {
  const files = unzipSync(new Uint8Array(await readFile("public/templates/forwarding-state-template.xlsx")));
  const values: Array<[number, string, string]> = [
    [2, "A2", "1.0"], [2, "B2", "直连路由验收"], [2, "C2", "2026-09-06T08:00:00.000Z"], [2, "D2", "自动化最小有效快照"],
    [3, "A2", "MDC-DH1E-G13-39U-CSW-001"], [3, "B2", "eth0"], [3, "C2", "physical"], [3, "D2", "routed"], [3, "E2", "default"], [3, "J2", "up"],
    [3, "A3", "MDC-DH1E-G13-39U-CSW-002"], [3, "B3", "eth0"], [3, "C3", "physical"], [3, "D3", "routed"], [3, "E3", "default"], [3, "J3", "up"],
    [5, "A2", "MDC-DH1E-G13-39U-CSW-001"], [5, "B2", "default"], [5, "C2", "10.0.0.2/32"], [5, "D2", "connected"], [5, "F2", "eth0"],
    [6, "A2", "MDC-DH1E-G13-39U-CSW-001"], [6, "B2", "default"], [6, "C2", "10.0.0.2"], [6, "D2", "02:00:00:00:00:02"], [6, "E2", "eth0"], [6, "F2", "reachable"],
  ];
  for (const [sheet, reference, value] of values) setWorkbookCell(files, sheet, reference, value);
  return Buffer.from(zipSync(files));
}

async function deviceForwardingWorkbook(deviceName: string, batchName: string, includeRoute: boolean): Promise<Buffer> {
  const files = unzipSync(new Uint8Array(await readFile("public/templates/forwarding-state-template.xlsx")));
  const values: Array<[number, string, string]> = [
    [2, "A2", "1.0"], [2, "B2", batchName], [2, "C2", "2026-09-06T08:00:00.000Z"],
    [3, "A2", deviceName], [3, "B2", "eth0"], [3, "C2", "physical"], [3, "D2", "routed"], [3, "E2", "default"], [3, "J2", "up"],
  ];
  if (includeRoute) values.push(
    [5, "A2", deviceName], [5, "B2", "default"], [5, "C2", "10.0.0.2/32"], [5, "D2", "connected"], [5, "F2", "eth0"],
    [6, "A2", deviceName], [6, "B2", "default"], [6, "C2", "10.0.0.2"], [6, "D2", "02:00:00:00:00:02"], [6, "E2", "eth0"], [6, "F2", "reachable"],
  );
  for (const [sheet, reference, value] of values) setWorkbookCell(files, sheet, reference, value);
  return Buffer.from(zipSync(files));
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("topology API", () => {
  it("serves health, readiness and a whitelisted partial snapshot", async () => {
    const directory = await fixtureDirectory();
    const store = new TopologyStore(directory);
    await store.refresh();
    const app = createApp({ store });

    await request(app).get("/healthz").expect(200);
    await request(app).get("/readyz").expect(200);
    const response = await request(app).get("/api/topology").expect(200);
    expect(response.body.stats.configuredDevices).toBe(1);
    expect(response.body.stats.externalDevices).toBe(1);
    expect(response.body.stats.inventoryMatched).toBe(1);
    expect(response.body.warnings).toHaveLength(2);
    expect(JSON.stringify(response.body)).not.toContain("must-not-leak");
    expect(JSON.stringify(response.body)).not.toContain("SN001");
    expect(JSON.stringify(response.body)).not.toContain("hgx001");
  });

  it("serializes concurrent refreshes and retains the last successful snapshot", async () => {
    const directory = await fixtureDirectory();
    const store = new TopologyStore(directory);
    const first = store.refresh();
    const second = store.refresh();
    expect(first).toBe(second);
    const snapshot = await first;
    await rm(path.join(directory, "switch.md"));
    await expect(store.refresh()).rejects.toThrow();
    expect(store.current?.revision).toBe(snapshot.revision);

    const app = createApp({ store });
    const response = await request(app).post("/api/topology/refresh").expect(503);
    expect(response.body.retainedRevision).toBe(snapshot.revision);
    await request(app).get("/api/topology").expect(200);
  });

  it("validates, persists and resets manual GPU address overrides", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "data", "topology.db");
    const addressStore = new ServerAddressStore(databasePath);
    const store = new TopologyStore(directory, addressStore);
    await store.refresh();
    const app = createApp({ store });
    const hostname = "MDC-DH1E-J25-POD1-GPU-001";

    await request(app).put(`/api/server-addresses/${hostname}`).send({ inBandIp: "not-an-ip", outOfBandIp: "" }).expect(400);
    const updated = await request(app).put(`/api/server-addresses/${hostname}`).send({ inBandIp: "10.10.1.9", outOfBandIp: "192.168.1.9" }).expect(200);
    const updatedNode = updated.body.nodes.find((node: { hostname: string }) => node.hostname === hostname);
    expect(updatedNode.serverInfo).toMatchObject({ inBandIp: "10.10.1.9", outOfBandIp: "192.168.1.9", manualOverride: true });
    expect(updated.body.stats.manualOverrides).toBe(1);

    addressStore.close();
    const reopenedAddressStore = new ServerAddressStore(databasePath);
    const restartedStore = new TopologyStore(directory, reopenedAddressStore);
    const restartedSnapshot = await restartedStore.refresh();
    expect(restartedSnapshot.nodes.find((node) => node.hostname === hostname)?.serverInfo).toMatchObject({ inBandIp: "10.10.1.9", manualOverride: true });

    const reset = await request(createApp({ store: restartedStore })).delete(`/api/server-addresses/${hostname}`).expect(200);
    const resetNode = reset.body.nodes.find((node: { hostname: string }) => node.hostname === hostname);
    expect(resetNode.serverInfo).toMatchObject({ inBandIp: "10.10.1.1", outOfBandIp: "192.168.1.1", manualOverride: false });
    reopenedAddressStore.close();
  });

  it("validates and shares a saved topology layout after a restart", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "layout-data", "topology.db");
    const persistence = new ServerAddressStore(databasePath);
    const store = new TopologyStore(directory, persistence);
    const initial = await store.refresh();
    const nodeId = initial.nodes.find((node) => node.kind === "configured")!.id;
    const app = createApp({ store });

    await request(app).put("/api/topology/layout").send({ positions: { unknown: { x: 1, y: 2 } } }).expect(400);
    await request(app).put("/api/topology/layout").send({ positions: { [nodeId]: { x: 2_000_000, y: 2 } } }).expect(400);
    const saved = await request(app).put("/api/topology/layout").send({ positions: { [nodeId]: { x: 321.5, y: 654.25 } } }).expect(200);
    expect(saved.body.layoutPositions[nodeId]).toEqual({ x: 321.5, y: 654.25 });
    persistence.close();

    const reopenedPersistence = new ServerAddressStore(databasePath);
    const restartedStore = new TopologyStore(directory, reopenedPersistence);
    const restarted = await restartedStore.refresh();
    expect(restarted.layoutPositions[nodeId]).toEqual({ x: 321.5, y: 654.25 });
    reopenedPersistence.close();
  });

  it("persists projects, imported topologies, names, LIDs and independent layouts", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "catalog-data", "topology.db");
    const persistence = new ServerAddressStore(databasePath);
    const store = new TopologyStore(directory, persistence);
    await store.refresh();
    const app = createApp({ store });

    const initialProjects = await request(app).get("/api/projects").expect(200);
    expect(initialProjects.body[0]).toMatchObject({ id: "metta", name: "Metta" });
    expect(initialProjects.body[0].topologies[0]).toMatchObject({ id: "metta-roce", name: "Metta RoCE网络", sourceType: "nvue" });

    const createdProject = await request(app).post("/api/projects").send({ name: "训练集群" }).expect(201);
    const projectId = createdProject.body.id as string;
    const renamedProject = await request(app).put(`/api/projects/${projectId}`).send({ name: "训练网络" }).expect(200);
    expect(renamedProject.body.name).toBe("训练网络");

    await request(app).post(`/api/projects/${projectId}/topologies/import`).send({ name: "损坏的 Excel", fileName: "ports.xlsx" }).expect(400);
    const brokenXlsx = await request(app).post(`/api/projects/${projectId}/topologies/import`).send({ name: "损坏的 Excel", fileName: "ports.xlsx", xlsxBase64: Buffer.from("not-an-xlsx").toString("base64") }).expect(400);
    expect(brokenXlsx.body.error).toMatch(/XLSX 解析失败/);

    const csvText = `System,Port,LID,Peer Node,Peer Port,Peer LID\nPOD1-IBLF-001,1,11,POD1-GPU-001,eth0,22\nPOD1-GPU-001,eth0,22,POD1-IBLF-001,1,11\n`;
    const imported = await request(app).post(`/api/projects/${projectId}/topologies/import`).send({ name: "IB 网络", fileName: "ports.csv", csvText }).expect(201);
    const topologyId = imported.body.topologyId as string;
    expect(imported.body.snapshot).toMatchObject({ sourceType: "ports-csv", stats: { configuredDevices: 1, externalDevices: 1, physicalLinks: 1 } });
    const importedGpu = imported.body.snapshot.nodes.find((node: { hostname: string }) => node.hostname === "POD1-GPU-001");
    expect(importedGpu.lids).toEqual(["22"]);
    expect(importedGpu.interfaces[0]).not.toHaveProperty("lid");
    expect(JSON.stringify(imported.body)).not.toContain(csvText);

    const nodeId = imported.body.snapshot.nodes[0].id as string;
    await request(app).put(`/api/projects/${projectId}/topologies/${topologyId}/layout`).send({ positions: { [nodeId]: { x: 81, y: 93 } } }).expect(200);
    const renamedTopology = await request(app).put(`/api/projects/${projectId}/topologies/${topologyId}`).send({ name: "Metta IB网络" }).expect(200);
    expect(renamedTopology.body.topologies[0].name).toBe("Metta IB网络");
    persistence.close();

    const reopenedPersistence = new ServerAddressStore(databasePath);
    const restartedStore = new TopologyStore(directory, reopenedPersistence);
    await restartedStore.refresh();
    const persisted = await request(createApp({ store: restartedStore })).get(`/api/projects/${projectId}/topologies/${topologyId}`).expect(200);
    expect(persisted.body.layoutPositions[nodeId]).toEqual({ x: 81, y: 93 });
    expect((await request(createApp({ store: restartedStore })).get("/api/projects").expect(200)).body.find((project: { id: string }) => project.id === projectId).name).toBe("训练网络");
    reopenedPersistence.close();
  });

  it("exposes isolated forwarding snapshot endpoints and returns structured workbook issues", async () => {
    const directory = await fixtureDirectory();
    const persistence = new ServerAddressStore(":memory:");
    const store = new TopologyStore(directory, persistence);
    await store.refresh();
    const app = createApp({ store });
    const base = "/api/projects/metta/topologies/metta-roce/forwarding-snapshots";

    const empty = await request(app).get(base).expect(200);
    expect(empty.body).toEqual({ snapshots: [] });
    const workbook = await readFile("public/templates/forwarding-state-template.xlsx");
    const invalid = await request(app)
      .post(base)
      .set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .send(workbook)
      .expect(422);
    expect(invalid.body.issues).toContainEqual(expect.objectContaining({ sheet: "接口属性", row: 2, column: "设备" }));
    expect((await request(app).get(base).expect(200)).body.snapshots).toEqual([]);
    await request(app).post(`${base}/unknown/traces`).send({ sourceDeviceId: "unknown", sourceIp: "10.0.0.1", destinationIp: "10.0.0.2" }).expect(404);
    persistence.close();
  });

  it("imports a valid forwarding workbook and traces a directly connected route", async () => {
    const directory = await forwardingFixtureDirectory();
    const persistence = new ServerAddressStore(":memory:");
    const store = new TopologyStore(directory, persistence);
    await store.refresh();
    const app = createApp({ store });
    const base = "/api/projects/metta/topologies/metta-roce/forwarding-snapshots";
    const workbook = await directRouteWorkbook();

    const imported = await request(app)
      .post(base)
      .set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .send(workbook)
      .expect(201);
    expect(imported.body).toMatchObject({
      batchName: "直连路由验收",
      templateVersion: "1.0",
      isDefault: true,
      compatible: true,
      counts: { interfaces: 2, routes: 1, arpEntries: 1, lagMembers: 0, macEntries: 0, vxlanEntries: 0 },
    });

    const listed = await request(app).get(base).expect(200);
    expect(listed.body.defaultSnapshotId).toBe(imported.body.id);
    expect(listed.body.snapshots).toHaveLength(1);

    const topology = store.topology("metta", "metta-roce");
    const source = topology.nodes.find((node) => node.hostname === "MDC-DH1E-G13-39U-CSW-001")!;
    const destination = topology.nodes.find((node) => node.hostname === "MDC-DH1E-G13-39U-CSW-002")!;
    const trace = await request(app)
      .post(`${base}/${imported.body.id}/traces`)
      .send({ sourceDeviceId: source.id, sourceIp: "10.0.0.1", destinationIp: "10.0.0.2", sourceInterface: "eth0", vrf: "default" })
      .expect(200);
    expect(trace.body.transitions).toHaveLength(1);
    expect(trace.body.transitions[0]).toMatchObject({ fromDeviceId: source.id, toDeviceId: destination.id, outputInterface: "eth0", inputInterface: "eth0" });
    expect(trace.body.endpoints).toContainEqual(expect.objectContaining({ deviceId: destination.id, code: "DELIVERED" }));
    expect(trace.body.states.flatMap((state: { evidence?: Array<{ sheet: string; row: number }> }) => state.evidence ?? [])).toEqual(expect.arrayContaining([
      expect.objectContaining({ sheet: "路由表", row: 2 }),
      expect.objectContaining({ sheet: "ARP表", row: 2 }),
    ]));
    persistence.close();
  });

  it("merges multiple device workbooks by topology device name and preserves file evidence", async () => {
    const directory = await forwardingFixtureDirectory();
    const persistence = new ServerAddressStore(":memory:");
    const store = new TopologyStore(directory, persistence);
    await store.refresh();
    const app = createApp({ store });
    const base = "/api/projects/metta/topologies/metta-roce/forwarding-snapshots";
    const first = await deviceForwardingWorkbook("MDC-DH1E-G13-39U-CSW-001", "设备 A", true);
    const second = await deviceForwardingWorkbook("MDC-DH1E-G13-39U-CSW-002", "设备 B", false);

    const imported = await request(app).post(base).send({ files: [
      { name: "switch-a.xlsx", contentBase64: first.toString("base64") },
      { name: "switch-b.xlsx", contentBase64: second.toString("base64") },
    ] }).expect(201);
    expect(imported.body.counts).toMatchObject({ interfaces: 2, routes: 1, arpEntries: 1 });

    const topology = store.topology("metta", "metta-roce");
    const source = topology.nodes.find((node) => node.hostname === "MDC-DH1E-G13-39U-CSW-001")!;
    const traced = await request(app).post(`${base}/${imported.body.id}/traces`).send({
      sourceDeviceId: source.id,
      sourceIp: "10.0.0.1",
      destinationIp: "10.0.0.2",
    }).expect(200);
    expect(traced.body.endpoints).toContainEqual(expect.objectContaining({ code: "DELIVERED" }));
    expect(traced.body.states.flatMap((state: { evidence?: Array<{ sourceFile?: string }> }) => state.evidence ?? [])).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceFile: "switch-a.xlsx" }),
    ]));
    persistence.close();
  });
});
