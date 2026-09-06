import { isIP } from "node:net";
import { Readable } from "node:stream";
import readXlsxFile from "read-excel-file/node";
import type { Sheet } from "read-excel-file/node";
import type {
  ForwardingArp,
  ForwardingImportIssue,
  ForwardingInterface,
  ForwardingLagMember,
  ForwardingMac,
  ForwardingMetadata,
  ForwardingRoute,
  ForwardingSnapshotData,
  ForwardingVxlan,
} from "../shared/forwarding.js";
import type { TopologyNode, TopologySnapshot } from "../shared/topology.js";

const MAX_FORWARDING_WORKBOOK_SIZE = 24 * 1024 * 1024;
const REQUIRED_SHEETS = ["说明", "元数据", "接口属性", "聚合成员", "路由表", "ARP表", "MAC表", "VXLAN"] as const;

const HEADERS = {
  元数据: ["模板版本", "批次名称", "采集时间", "备注"],
  接口属性: ["设备", "接口", "接口类型", "转发模式", "VRF", "VLAN", "允许VLAN", "Bridge", "接口MAC", "状态"],
  聚合成员: ["设备", "聚合接口", "成员接口", "状态"],
  路由表: ["设备", "VRF", "目的网段", "动作", "下一跳", "出接口", "ECMP组", "VNI", "远端VTEP"],
  ARP表: ["设备", "VRF", "IP", "MAC", "接口", "状态"],
  MAC表: ["设备", "VLAN", "MAC", "动作", "出接口", "VNI", "远端VTEP"],
  VXLAN: ["设备", "VNI", "模式", "本端VTEP", "VLAN", "租户VRF", "Underlay VRF", "UDP目的端口", "状态"],
} as const;

type DataSheetName = keyof typeof HEADERS;
type Cell = string | number | boolean | Date | null | undefined;
type Row = Cell[];

export class ForwardingWorkbookError extends Error {
  constructor(public readonly issues: ForwardingImportIssue[]) {
    super(`转发表工作簿校验失败，共 ${issues.length} 项错误`);
  }
}

export interface ForwardingWorkbookInput {
  fileName: string;
  xlsxBytes: Buffer;
}

function text(value: Cell): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function addIssue(issues: ForwardingImportIssue[], sheet: string, row: number, column: string, message: string, sourceFile?: string): void {
  if (issues.length < 1000) issues.push({ sourceFile, sheet, row, column, message });
}

function canonicalMac(value: string): string | undefined {
  const compact = value.trim().toLowerCase().replace(/[.:-]/g, "");
  if (!/^[0-9a-f]{12}$/.test(compact)) return undefined;
  return compact.match(/.{2}/g)!.join(":");
}

function ipv4(value: string): string | undefined {
  return isIP(value) === 4 ? value : undefined;
}

function ipv4Cidr(value: string): string | undefined {
  const parts = value.split("/");
  if (parts.length !== 2 || isIP(parts[0]) !== 4) return undefined;
  const prefix = Number(parts[1]);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32 ? `${parts[0]}/${prefix}` : undefined;
}

function integer(value: string, minimum: number, maximum: number): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function vlanList(value: string): number[] | undefined {
  if (!value) return [];
  const result = new Set<number>();
  for (const part of value.split(",").map((item) => item.trim())) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) return undefined;
    const start = integer(match[1], 1, 4094);
    const end = integer(match[2] ?? match[1], 1, 4094);
    if (start === undefined || end === undefined || start > end) return undefined;
    for (let current = start; current <= end; current += 1) result.add(current);
  }
  return [...result].sort((a, b) => a - b);
}

function enumValue<T extends string>(value: string, values: Record<string, T>): T | undefined {
  return values[normalized(value)];
}

const STATUS = { up: "up", 上: "up", down: "down", 下: "down" } as const;
const INTERFACE_TYPES = {
  physical: "physical", 物理: "physical", logical: "logical", 逻辑: "logical",
  svi: "svi", vlaninterface: "svi", lag: "lag", 聚合: "lag", vxlan: "vxlan",
} as const;
const FORWARDING_MODES = {
  routed: "routed", 三层: "routed", access: "access", trunk: "trunk",
} as const;
const ROUTE_ACTIONS = {
  forward: "forward", 转发: "forward", connected: "connected", 直连: "connected",
  local: "local", 本地: "local", drop: "drop", 丢弃: "drop", vxlan: "vxlan",
} as const;
const ARP_STATUS = {
  reachable: "reachable", 可达: "reachable", stale: "stale", 陈旧: "stale",
  static: "static", 静态: "static", incomplete: "incomplete", 未完成: "incomplete",
} as const;
const MAC_ACTIONS = {
  interface: "interface", 接口: "interface", remote: "remote", 远端: "remote",
  drop: "drop", 丢弃: "drop",
} as const;
const VXLAN_MODES = { l2: "l2", l2vni: "l2", 二层: "l2", l3: "l3", l3vni: "l3", 三层: "l3" } as const;

interface DeviceIndex {
  byName: Map<string, TopologyNode[]>;
  interfaces: Map<string, Set<string>>;
}

function buildDeviceIndex(topology: TopologySnapshot): DeviceIndex {
  const byName = new Map<string, TopologyNode[]>();
  for (const node of topology.nodes) {
    for (const alias of new Set([node.id, node.hostname, node.label].map(normalized).filter(Boolean))) {
      const matches = byName.get(alias) ?? [];
      if (!matches.some((item) => item.id === node.id)) matches.push(node);
      byName.set(alias, matches);
    }
  }
  const interfaces = new Map<string, Set<string>>();
  for (const node of topology.nodes) interfaces.set(node.id, new Set(node.interfaces.map((item) => normalized(item.name))));
  for (const link of topology.links) {
    interfaces.get(link.source)?.add(normalized(link.sourceInterface));
    interfaces.get(link.target)?.add(normalized(link.targetInterface));
  }
  return { byName, interfaces };
}

function resolveDevice(value: string, row: number, sheet: string, issues: ForwardingImportIssue[], devices: DeviceIndex): TopologyNode | undefined {
  if (!value) {
    addIssue(issues, sheet, row, "设备", "设备不能为空");
    return undefined;
  }
  const matches = devices.byName.get(normalized(value)) ?? [];
  if (matches.length === 0) {
    addIssue(issues, sheet, row, "设备", `拓扑中不存在设备 ${value}`);
    return undefined;
  }
  if (matches.length > 1) {
    addIssue(issues, sheet, row, "设备", `设备名 ${value} 在拓扑中匹配到多个设备，请改用唯一主机名`);
    return undefined;
  }
  return matches[0];
}

function verifyInterface(device: TopologyNode | undefined, value: string, row: number, sheet: string, column: string, issues: ForwardingImportIssue[], devices: DeviceIndex, required = true): boolean {
  if (!value) {
    if (required) addIssue(issues, sheet, row, column, `${column}不能为空`);
    return !required;
  }
  if (device && !devices.interfaces.get(device.id)?.has(normalized(value))) {
    addIssue(issues, sheet, row, column, `设备 ${device.hostname} 上不存在接口 ${value}`);
    return false;
  }
  return true;
}

function rowsFor(sheet: Sheet, name: DataSheetName, issues: ForwardingImportIssue[]): Array<{ row: number; value: Record<string, string> }> {
  const rows = sheet.data as Row[];
  if (rows.length === 0) {
    addIssue(issues, name, 1, "表头", "Sheet 为空");
    return [];
  }
  const actual = rows[0].map(text);
  const expected = [...HEADERS[name]];
  for (const [index, column] of expected.entries()) {
    if (actual[index] !== column) addIssue(issues, name, 1, column, `第 ${index + 1} 列应为“${column}”`);
  }
  for (let index = expected.length; index < actual.length; index += 1) {
    if (actual[index]) addIssue(issues, name, 1, actual[index], `存在未定义字段“${actual[index]}”`);
  }
  return rows.slice(1).flatMap((raw, index) => {
    if (raw.every((cell) => !text(cell))) return [];
    return [{ row: index + 2, value: Object.fromEntries(expected.map((column, columnIndex) => [column, text(raw[columnIndex])])) }];
  });
}

function parseMetadata(sheet: Sheet, issues: ForwardingImportIssue[]): ForwardingMetadata {
  const rows = rowsFor(sheet, "元数据", issues);
  if (rows.length !== 1) addIssue(issues, "元数据", 2, "批次名称", "元数据必须且只能包含一行");
  const value = rows[0]?.value ?? {};
  if (value["模板版本"] !== "1.0" && value["模板版本"] !== "1") addIssue(issues, "元数据", rows[0]?.row ?? 2, "模板版本", "模板版本必须为 1.0");
  if (!value["批次名称"] || value["批次名称"].length > 120) addIssue(issues, "元数据", rows[0]?.row ?? 2, "批次名称", "批次名称必须为 1 至 120 个字符");
  if (!value["采集时间"] || Number.isNaN(Date.parse(value["采集时间"]))) addIssue(issues, "元数据", rows[0]?.row ?? 2, "采集时间", "采集时间必须是有效日期时间");
  return {
    templateVersion: value["模板版本"] === "1" ? "1.0" : value["模板版本"] ?? "",
    batchName: value["批次名称"] ?? "",
    collectedAt: value["采集时间"] ? new Date(value["采集时间"]).toISOString() : "",
    note: value["备注"] || undefined,
  };
}

function parseInterfaces(sheet: Sheet, issues: ForwardingImportIssue[], devices: DeviceIndex): ForwardingInterface[] {
  const result: ForwardingInterface[] = [];
  const keys = new Set<string>();
  for (const { row, value } of rowsFor(sheet, "接口属性", issues)) {
    const device = resolveDevice(value["设备"], row, "接口属性", issues, devices);
    verifyInterface(device, value["接口"], row, "接口属性", "接口", issues, devices);
    const interfaceType = enumValue(value["接口类型"], INTERFACE_TYPES);
    const forwardingMode = enumValue(value["转发模式"], FORWARDING_MODES);
    const status = enumValue(value["状态"], STATUS);
    if (!interfaceType) addIssue(issues, "接口属性", row, "接口类型", "接口类型必须为 physical、logical、svi、lag 或 vxlan");
    if (!forwardingMode) addIssue(issues, "接口属性", row, "转发模式", "转发模式必须为 routed、access 或 trunk");
    if (!status) addIssue(issues, "接口属性", row, "状态", "状态必须为 up 或 down");
    const vlan = value["VLAN"] ? integer(value["VLAN"], 1, 4094) : undefined;
    if (value["VLAN"] && vlan === undefined) addIssue(issues, "接口属性", row, "VLAN", "VLAN 必须是 1 至 4094 的整数");
    const allowedVlans = vlanList(value["允许VLAN"]);
    if (!allowedVlans) addIssue(issues, "接口属性", row, "允许VLAN", "允许VLAN 必须使用逗号或区间，例如 1000,1020-1024");
    const mac = value["接口MAC"] ? canonicalMac(value["接口MAC"]) : undefined;
    if (value["接口MAC"] && !mac) addIssue(issues, "接口属性", row, "接口MAC", "接口MAC格式无效");
    if (forwardingMode === "routed" && !value["VRF"]) addIssue(issues, "接口属性", row, "VRF", "三层接口必须填写 VRF");
    if (forwardingMode === "access" && vlan === undefined) addIssue(issues, "接口属性", row, "VLAN", "Access 接口必须填写 VLAN");
    if (forwardingMode === "trunk" && (allowedVlans?.length ?? 0) === 0) addIssue(issues, "接口属性", row, "允许VLAN", "Trunk 接口必须填写允许 VLAN");
    if (!device || !interfaceType || !forwardingMode || !status || !allowedVlans) continue;
    const key = `${device.id}\0${normalized(value["接口"])}`;
    if (keys.has(key)) addIssue(issues, "接口属性", row, "接口", "同一设备接口存在重复定义");
    keys.add(key);
    result.push({ row, deviceId: device.id, deviceName: device.hostname, interfaceName: value["接口"], interfaceType, forwardingMode, vrf: value["VRF"] || "default", vlan, allowedVlans, bridge: value["Bridge"] || undefined, mac, status });
  }
  if (result.length === 0) addIssue(issues, "接口属性", 2, "设备", "至少需要一条接口属性记录");
  return result;
}

function parseLagMembers(sheet: Sheet, issues: ForwardingImportIssue[], devices: DeviceIndex): ForwardingLagMember[] {
  const result: ForwardingLagMember[] = [];
  const keys = new Set<string>();
  for (const { row, value } of rowsFor(sheet, "聚合成员", issues)) {
    const device = resolveDevice(value["设备"], row, "聚合成员", issues, devices);
    verifyInterface(device, value["聚合接口"], row, "聚合成员", "聚合接口", issues, devices);
    verifyInterface(device, value["成员接口"], row, "聚合成员", "成员接口", issues, devices);
    const status = enumValue(value["状态"], STATUS);
    if (!status) addIssue(issues, "聚合成员", row, "状态", "状态必须为 up 或 down");
    if (!device || !status) continue;
    const key = `${device.id}\0${normalized(value["聚合接口"])}\0${normalized(value["成员接口"])}`;
    if (keys.has(key)) addIssue(issues, "聚合成员", row, "成员接口", "聚合成员存在重复定义");
    keys.add(key);
    result.push({ row, deviceId: device.id, deviceName: device.hostname, aggregateInterface: value["聚合接口"], memberInterface: value["成员接口"], status });
  }
  return result;
}

function parseRoutes(sheet: Sheet, issues: ForwardingImportIssue[], devices: DeviceIndex): ForwardingRoute[] {
  const result: ForwardingRoute[] = [];
  for (const { row, value } of rowsFor(sheet, "路由表", issues)) {
    const device = resolveDevice(value["设备"], row, "路由表", issues, devices);
    const cidr = ipv4Cidr(value["目的网段"]);
    const action = enumValue(value["动作"], ROUTE_ACTIONS);
    if (!value["VRF"]) addIssue(issues, "路由表", row, "VRF", "VRF不能为空");
    if (!cidr) addIssue(issues, "路由表", row, "目的网段", "目的网段必须是 IPv4 CIDR");
    if (!action) addIssue(issues, "路由表", row, "动作", "动作必须为 forward、connected、local、drop 或 vxlan");
    if (value["下一跳"] && !ipv4(value["下一跳"])) addIssue(issues, "路由表", row, "下一跳", "下一跳必须是 IPv4 地址");
    if (value["远端VTEP"] && !ipv4(value["远端VTEP"])) addIssue(issues, "路由表", row, "远端VTEP", "远端VTEP必须是 IPv4 地址");
    const vni = value["VNI"] ? integer(value["VNI"], 1, 16_777_215) : undefined;
    if (value["VNI"] && vni === undefined) addIssue(issues, "路由表", row, "VNI", "VNI 必须是 1 至 16777215 的整数");
    if ((action === "forward" || action === "connected") && !value["出接口"]) addIssue(issues, "路由表", row, "出接口", `${action} 动作必须填写出接口`);
    if (value["出接口"]) verifyInterface(device, value["出接口"], row, "路由表", "出接口", issues, devices);
    if (action === "vxlan" && (vni === undefined || !value["远端VTEP"])) addIssue(issues, "路由表", row, "VNI", "VXLAN 路由必须填写 VNI 和远端VTEP");
    if (!device || !cidr || !action) continue;
    result.push({ row, deviceId: device.id, deviceName: device.hostname, vrf: value["VRF"], destinationCidr: cidr, action, nextHop: value["下一跳"] || undefined, outputInterface: value["出接口"] || undefined, ecmpGroup: value["ECMP组"] || undefined, vni, remoteVtep: value["远端VTEP"] || undefined });
  }
  const byPrefix = new Map<string, ForwardingRoute[]>();
  for (const route of result) {
    const key = `${route.deviceId}\0${normalized(route.vrf)}\0${route.destinationCidr}`;
    byPrefix.set(key, [...(byPrefix.get(key) ?? []), route]);
  }
  for (const routes of byPrefix.values()) {
    if (routes.length <= 1) continue;
    const groups = new Set(routes.map((route) => route.ecmpGroup).filter(Boolean));
    if (groups.size !== 1 || routes.some((route) => !route.ecmpGroup)) {
      for (const route of routes) addIssue(issues, "路由表", route.row, "ECMP组", "同设备、VRF和前缀的多条路由必须属于同一个非空 ECMP 组");
    }
  }
  return result;
}

function parseArp(sheet: Sheet, issues: ForwardingImportIssue[], devices: DeviceIndex): ForwardingArp[] {
  const result: ForwardingArp[] = [];
  const keys = new Set<string>();
  for (const { row, value } of rowsFor(sheet, "ARP表", issues)) {
    const device = resolveDevice(value["设备"], row, "ARP表", issues, devices);
    if (!value["VRF"]) addIssue(issues, "ARP表", row, "VRF", "VRF不能为空");
    const ip = ipv4(value["IP"]);
    const mac = canonicalMac(value["MAC"]);
    const status = enumValue(value["状态"], ARP_STATUS);
    if (!ip) addIssue(issues, "ARP表", row, "IP", "IP必须是 IPv4 地址");
    if (!mac) addIssue(issues, "ARP表", row, "MAC", "MAC格式无效");
    if (!status) addIssue(issues, "ARP表", row, "状态", "状态必须为 reachable、stale、static 或 incomplete");
    verifyInterface(device, value["接口"], row, "ARP表", "接口", issues, devices);
    if (!device || !ip || !mac || !status) continue;
    const key = `${device.id}\0${normalized(value["VRF"])}\0${ip}`;
    if (keys.has(key)) addIssue(issues, "ARP表", row, "IP", "同一设备和 VRF 的 ARP IP 重复");
    keys.add(key);
    result.push({ row, deviceId: device.id, deviceName: device.hostname, vrf: value["VRF"], ip, mac, interfaceName: value["接口"], status });
  }
  return result;
}

function parseMac(sheet: Sheet, issues: ForwardingImportIssue[], devices: DeviceIndex): ForwardingMac[] {
  const result: ForwardingMac[] = [];
  const keys = new Set<string>();
  for (const { row, value } of rowsFor(sheet, "MAC表", issues)) {
    const device = resolveDevice(value["设备"], row, "MAC表", issues, devices);
    const vlan = integer(value["VLAN"], 1, 4094);
    const mac = canonicalMac(value["MAC"]);
    const action = enumValue(value["动作"], MAC_ACTIONS);
    if (vlan === undefined) addIssue(issues, "MAC表", row, "VLAN", "VLAN 必须是 1 至 4094 的整数");
    if (!mac) addIssue(issues, "MAC表", row, "MAC", "MAC格式无效");
    if (!action) addIssue(issues, "MAC表", row, "动作", "动作必须为 interface、remote 或 drop");
    const vni = value["VNI"] ? integer(value["VNI"], 1, 16_777_215) : undefined;
    if (value["VNI"] && vni === undefined) addIssue(issues, "MAC表", row, "VNI", "VNI 必须是 1 至 16777215 的整数");
    if (value["远端VTEP"] && !ipv4(value["远端VTEP"])) addIssue(issues, "MAC表", row, "远端VTEP", "远端VTEP必须是 IPv4 地址");
    if (action === "interface") verifyInterface(device, value["出接口"], row, "MAC表", "出接口", issues, devices);
    if (action === "remote" && (vni === undefined || !value["远端VTEP"])) addIssue(issues, "MAC表", row, "VNI", "远端 MAC 必须填写 VNI 和远端VTEP");
    if (!device || vlan === undefined || !mac || !action) continue;
    const key = `${device.id}\0${vlan}\0${mac}`;
    if (keys.has(key)) addIssue(issues, "MAC表", row, "MAC", "同一设备和 VLAN 的 MAC 重复");
    keys.add(key);
    result.push({ row, deviceId: device.id, deviceName: device.hostname, vlan, mac, action, outputInterface: value["出接口"] || undefined, vni, remoteVtep: value["远端VTEP"] || undefined });
  }
  return result;
}

function parseVxlan(sheet: Sheet, issues: ForwardingImportIssue[], devices: DeviceIndex): ForwardingVxlan[] {
  const result: ForwardingVxlan[] = [];
  const keys = new Set<string>();
  for (const { row, value } of rowsFor(sheet, "VXLAN", issues)) {
    const device = resolveDevice(value["设备"], row, "VXLAN", issues, devices);
    const vni = integer(value["VNI"], 1, 16_777_215);
    const mode = enumValue(value["模式"], VXLAN_MODES);
    const localVtep = ipv4(value["本端VTEP"]);
    const vlan = value["VLAN"] ? integer(value["VLAN"], 1, 4094) : undefined;
    const udpDestinationPort = value["UDP目的端口"] ? integer(value["UDP目的端口"], 1, 65535) : 4789;
    const status = enumValue(value["状态"], STATUS);
    if (vni === undefined) addIssue(issues, "VXLAN", row, "VNI", "VNI 必须是 1 至 16777215 的整数");
    if (!mode) addIssue(issues, "VXLAN", row, "模式", "模式必须为 L2VNI 或 L3VNI");
    if (!localVtep) addIssue(issues, "VXLAN", row, "本端VTEP", "本端VTEP必须是 IPv4 地址");
    if (value["VLAN"] && vlan === undefined) addIssue(issues, "VXLAN", row, "VLAN", "VLAN 必须是 1 至 4094 的整数");
    if (mode === "l2" && vlan === undefined) addIssue(issues, "VXLAN", row, "VLAN", "L2VNI 必须填写 VLAN");
    if (mode === "l3" && !value["租户VRF"]) addIssue(issues, "VXLAN", row, "租户VRF", "L3VNI 必须填写租户VRF");
    if (!value["Underlay VRF"]) addIssue(issues, "VXLAN", row, "Underlay VRF", "Underlay VRF不能为空");
    if (udpDestinationPort === undefined) addIssue(issues, "VXLAN", row, "UDP目的端口", "UDP目的端口必须是 1 至 65535 的整数");
    if (!status) addIssue(issues, "VXLAN", row, "状态", "状态必须为 up 或 down");
    if (!device || vni === undefined || !mode || !localVtep || udpDestinationPort === undefined || !status) continue;
    const key = `${device.id}\0${vni}`;
    if (keys.has(key)) addIssue(issues, "VXLAN", row, "VNI", "同一设备的 VNI 重复");
    keys.add(key);
    result.push({ row, deviceId: device.id, deviceName: device.hostname, vni, mode, localVtep, vlan, tenantVrf: value["租户VRF"] || undefined, underlayVrf: value["Underlay VRF"], udpDestinationPort, status });
  }
  return result;
}

function validateReferences(data: ForwardingSnapshotData, issues: ForwardingImportIssue[]): void {
  const interfaces = new Map(data.interfaces.map((item) => [`${item.deviceId}\0${normalized(item.interfaceName)}`, item]));
  const vxlans = new Map(data.vxlanEntries.map((item) => [`${item.deviceId}\0${item.vni}`, item]));
  for (const member of data.lagMembers) {
    const aggregate = interfaces.get(`${member.deviceId}\0${normalized(member.aggregateInterface)}`);
    const physical = interfaces.get(`${member.deviceId}\0${normalized(member.memberInterface)}`);
    if (!aggregate || aggregate.interfaceType !== "lag") addIssue(issues, "聚合成员", member.row, "聚合接口", "聚合接口必须在接口属性中定义为 lag", member.sourceFile);
    if (!physical || physical.interfaceType !== "physical") addIssue(issues, "聚合成员", member.row, "成员接口", "成员接口必须在接口属性中定义为 physical", member.sourceFile);
  }
  for (const route of data.routes) {
    if (route.outputInterface && !interfaces.has(`${route.deviceId}\0${normalized(route.outputInterface)}`)) addIssue(issues, "路由表", route.row, "出接口", "出接口必须在接口属性中定义", route.sourceFile);
  }
  for (const arp of data.arpEntries) {
    if (!interfaces.has(`${arp.deviceId}\0${normalized(arp.interfaceName)}`)) addIssue(issues, "ARP表", arp.row, "接口", "接口必须在接口属性中定义", arp.sourceFile);
  }
  for (const mac of data.macEntries) {
    if (mac.outputInterface && !interfaces.has(`${mac.deviceId}\0${normalized(mac.outputInterface)}`)) addIssue(issues, "MAC表", mac.row, "出接口", "出接口必须在接口属性中定义", mac.sourceFile);
  }
  for (const route of data.routes.filter((item) => item.action === "vxlan")) {
    const mapping = route.vni === undefined ? undefined : vxlans.get(`${route.deviceId}\0${route.vni}`);
    if (!mapping || mapping.mode !== "l3" || mapping.status !== "up") addIssue(issues, "路由表", route.row, "VNI", "VXLAN 路由必须引用本设备已启用的 L3VNI", route.sourceFile);
    else if (!data.vxlanEntries.some((item) => item.deviceId !== route.deviceId && item.mode === "l3" && item.vni === route.vni && item.localVtep === route.remoteVtep && item.status === "up")) addIssue(issues, "路由表", route.row, "远端VTEP", "远端VTEP必须引用其他设备上同 VNI 的已启用 L3VNI", route.sourceFile);
  }
  for (const mac of data.macEntries.filter((item) => item.action === "remote")) {
    const mapping = mac.vni === undefined ? undefined : vxlans.get(`${mac.deviceId}\0${mac.vni}`);
    if (!mapping || mapping.mode !== "l2" || mapping.vlan !== mac.vlan || mapping.status !== "up") addIssue(issues, "MAC表", mac.row, "VNI", "远端 MAC 必须引用本设备同 VLAN 的 L2VNI", mac.sourceFile);
    else if (!data.vxlanEntries.some((item) => item.deviceId !== mac.deviceId && item.mode === "l2" && item.vni === mac.vni && item.localVtep === mac.remoteVtep && item.status === "up")) addIssue(issues, "MAC表", mac.row, "远端VTEP", "远端VTEP必须引用其他设备上同 VNI 的已启用 L2VNI", mac.sourceFile);
  }
  for (const vxlan of data.vxlanEntries) {
    if (vxlan.status !== "up") continue;
    const duplicateLocal = data.vxlanEntries.find((item) => item !== vxlan && item.deviceId !== vxlan.deviceId && item.localVtep === vxlan.localVtep);
    if (duplicateLocal) addIssue(issues, "VXLAN", vxlan.row, "本端VTEP", `本端VTEP与设备 ${duplicateLocal.deviceName} 重复`, vxlan.sourceFile);
  }
}

function attachSourceFile<T extends { row: number }>(items: T[], sourceFile?: string): T[] {
  return sourceFile ? items.map((item) => ({ ...item, sourceFile })) : items;
}

async function parseWorkbookPart(xlsxBytes: Buffer, topology: TopologySnapshot, sourceFile?: string, checkReferences = true): Promise<ForwardingSnapshotData> {
  if (xlsxBytes.byteLength === 0) throw new ForwardingWorkbookError([{ sourceFile, sheet: "工作簿", row: 0, column: "文件", message: "XLSX 内容不能为空" }]);
  if (xlsxBytes.byteLength > MAX_FORWARDING_WORKBOOK_SIZE) throw new ForwardingWorkbookError([{ sourceFile, sheet: "工作簿", row: 0, column: "文件", message: "XLSX 超过 24 MiB 限制" }]);
  let sheets: Sheet[];
  try {
    sheets = await readXlsxFile(Readable.from([xlsxBytes]));
  } catch (error) {
    throw new ForwardingWorkbookError([{ sourceFile, sheet: "工作簿", row: 0, column: "文件", message: error instanceof Error ? `XLSX 解析失败：${error.message}` : "XLSX 解析失败" }]);
  }
  const issues: ForwardingImportIssue[] = [];
  const byName = new Map(sheets.map((sheet) => [sheet.sheet, sheet]));
  for (const name of REQUIRED_SHEETS) if (!byName.has(name)) addIssue(issues, name, 0, "Sheet", `缺少 Sheet“${name}”`);
  for (const sheet of sheets) if (!(REQUIRED_SHEETS as readonly string[]).includes(sheet.sheet)) addIssue(issues, sheet.sheet, 0, "Sheet", `存在未定义 Sheet“${sheet.sheet}”`);
  const emptySheet = (name: string): Sheet => ({ sheet: name, data: [] });
  const devices = buildDeviceIndex(topology);
  const data: ForwardingSnapshotData = {
    metadata: parseMetadata(byName.get("元数据") ?? emptySheet("元数据"), issues),
    interfaces: attachSourceFile(parseInterfaces(byName.get("接口属性") ?? emptySheet("接口属性"), issues, devices), sourceFile),
    lagMembers: attachSourceFile(parseLagMembers(byName.get("聚合成员") ?? emptySheet("聚合成员"), issues, devices), sourceFile),
    routes: attachSourceFile(parseRoutes(byName.get("路由表") ?? emptySheet("路由表"), issues, devices), sourceFile),
    arpEntries: attachSourceFile(parseArp(byName.get("ARP表") ?? emptySheet("ARP表"), issues, devices), sourceFile),
    macEntries: attachSourceFile(parseMac(byName.get("MAC表") ?? emptySheet("MAC表"), issues, devices), sourceFile),
    vxlanEntries: attachSourceFile(parseVxlan(byName.get("VXLAN") ?? emptySheet("VXLAN"), issues, devices), sourceFile),
  };
  if (checkReferences) validateReferences(data, issues);
  if (issues.length > 0) throw new ForwardingWorkbookError(issues.map((issue) => ({ ...issue, sourceFile: issue.sourceFile ?? sourceFile })));
  return data;
}

function validateMergedDuplicates(data: ForwardingSnapshotData, issues: ForwardingImportIssue[]): void {
  const flagDuplicates = <T extends { row: number; sourceFile?: string }>(items: T[], keyFor: (item: T) => string, sheet: string, column: string, message: string) => {
    const seen = new Set<string>();
    for (const item of items) {
      const key = keyFor(item);
      if (seen.has(key)) addIssue(issues, sheet, item.row, column, message, item.sourceFile);
      seen.add(key);
    }
  };
  flagDuplicates(data.interfaces, (item) => `${item.deviceId}\0${normalized(item.interfaceName)}`, "接口属性", "接口", "同一设备接口在多个文件中重复定义");
  flagDuplicates(data.lagMembers, (item) => `${item.deviceId}\0${normalized(item.aggregateInterface)}\0${normalized(item.memberInterface)}`, "聚合成员", "成员接口", "聚合成员在多个文件中重复定义");
  flagDuplicates(data.arpEntries, (item) => `${item.deviceId}\0${normalized(item.vrf)}\0${item.ip}`, "ARP表", "IP", "同一设备和 VRF 的 ARP IP 在多个文件中重复");
  flagDuplicates(data.macEntries, (item) => `${item.deviceId}\0${item.vlan}\0${item.mac}`, "MAC表", "MAC", "同一设备和 VLAN 的 MAC 在多个文件中重复");
  flagDuplicates(data.vxlanEntries, (item) => `${item.deviceId}\0${item.vni}`, "VXLAN", "VNI", "同一设备的 VNI 在多个文件中重复");

  const routesByPrefix = new Map<string, ForwardingRoute[]>();
  for (const route of data.routes) {
    const key = `${route.deviceId}\0${normalized(route.vrf)}\0${route.destinationCidr}`;
    routesByPrefix.set(key, [...(routesByPrefix.get(key) ?? []), route]);
  }
  for (const routes of routesByPrefix.values()) {
    if (routes.length <= 1) continue;
    const groups = new Set(routes.map((route) => route.ecmpGroup).filter(Boolean));
    if (groups.size !== 1 || routes.some((route) => !route.ecmpGroup)) {
      for (const route of routes) addIssue(issues, "路由表", route.row, "ECMP组", "同设备、VRF和前缀的多条路由必须属于同一个非空 ECMP 组", route.sourceFile);
    }
  }
}

export async function parseForwardingWorkbook(xlsxBytes: Buffer, topology: TopologySnapshot): Promise<ForwardingSnapshotData> {
  return parseWorkbookPart(xlsxBytes, topology);
}

export async function parseForwardingWorkbooks(workbooks: ForwardingWorkbookInput[], topology: TopologySnapshot): Promise<ForwardingSnapshotData> {
  if (workbooks.length === 0) throw new ForwardingWorkbookError([{ sheet: "工作簿", row: 0, column: "文件", message: "至少选择一个 XLSX 文件" }]);
  const parts: ForwardingSnapshotData[] = [];
  const issues: ForwardingImportIssue[] = [];
  for (const workbook of workbooks) {
    try {
      parts.push(await parseWorkbookPart(workbook.xlsxBytes, topology, workbook.fileName, false));
    } catch (error) {
      if (error instanceof ForwardingWorkbookError) issues.push(...error.issues);
      else throw error;
    }
  }
  if (issues.length > 0) throw new ForwardingWorkbookError(issues.slice(0, 1000));

  const first = parts[0];
  const batchNames = [...new Set(parts.map((part) => part.metadata.batchName))];
  const merged: ForwardingSnapshotData = {
    metadata: {
      templateVersion: first.metadata.templateVersion,
      batchName: (batchNames.length === 1 ? batchNames[0] : `${batchNames[0]} 等 ${parts.length} 份`).slice(0, 120),
      collectedAt: parts.map((part) => part.metadata.collectedAt).sort().at(-1) ?? first.metadata.collectedAt,
      note: parts.length === 1 ? first.metadata.note : `合并导入：${workbooks.map((item) => item.fileName).join("、")}`,
    },
    interfaces: parts.flatMap((part) => part.interfaces),
    lagMembers: parts.flatMap((part) => part.lagMembers),
    routes: parts.flatMap((part) => part.routes),
    arpEntries: parts.flatMap((part) => part.arpEntries),
    macEntries: parts.flatMap((part) => part.macEntries),
    vxlanEntries: parts.flatMap((part) => part.vxlanEntries),
  };
  validateMergedDuplicates(merged, issues);
  validateReferences(merged, issues);
  if (issues.length > 0) throw new ForwardingWorkbookError(issues.slice(0, 1000));
  return merged;
}
