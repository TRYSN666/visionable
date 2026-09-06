export type DeviceKind = "configured" | "external";

export type DeviceRole =
  | "CSW"
  | "SSW"
  | "ASW"
  | "HSS"
  | "MGMT"
  | "LSW"
  | "SOOB"
  | "OOB"
  | "IBCR"
  | "IBSP"
  | "IBLF"
  | "SERVER"
  | "ENDPOINT"
  | "UNKNOWN";

export type PodName = "POD1" | "POD2" | "POD3" | "SHARED" | "UNKNOWN";
export type LinkPlane = "production" | "management";

export interface InterfaceAddress {
  cidr: string;
  type: "primary" | "vrr";
}

export interface InterfacePeer {
  device: string;
  interface: string;
  bandwidth?: string;
}

export interface InterfaceRecord {
  name: string;
  addresses: InterfaceAddress[];
  description?: string;
  logical?: boolean;
  peers: InterfacePeer[];
}

export interface ServerAddressInfo {
  inBandIp?: string;
  outOfBandIp?: string;
  inventoryInBandIp?: string;
  inventoryOutOfBandIp?: string;
  manualOverride: boolean;
  overrideUpdatedAt?: string;
}

export interface TopologyNode {
  id: string;
  kind: DeviceKind;
  hostname: string;
  label: string;
  role: DeviceRole;
  pod: PodName;
  rack?: string;
  endpointType?: string;
  managementIp?: string;
  lids?: string[];
  interfaces: InterfaceRecord[];
  clusterId?: string;
  serverInfo?: ServerAddressInfo;
}

export interface TopologyLink {
  id: string;
  source: string;
  target: string;
  sourceInterface: string;
  targetInterface: string;
  bandwidth?: string;
  plane: LinkPlane;
  confidence: "reciprocal" | "declared" | "inferred";
  reciprocal: boolean;
}

export interface EndpointCluster {
  id: string;
  label: string;
  pod: PodName;
  rack: string;
  endpointType: string;
  nodeIds: string[];
}

export interface TopologyWarning {
  code:
    | "FILE_SKIPPED"
    | "PARSE_ERROR"
    | "UNPAIRED_LINK"
    | "SOURCE_UNAVAILABLE"
    | "INVENTORY_ROW_SKIPPED"
    | "INVENTORY_DUPLICATE"
    | "INVENTORY_UNMATCHED"
    | "IMPORT_ROW_SKIPPED"
    | "IMPORT_LID_CONFLICT";
  message: string;
  sourceFile?: string;
}

export interface TopologyStats {
  configuredDevices: number;
  externalDevices: number;
  physicalLinks: number;
  internalLinks: number;
  externalLinks: number;
  usedInterfaces: number;
  sourceFiles: number;
  inventoryRecords: number;
  inventoryMatched: number;
  manualOverrides: number;
}

export interface TopologyPosition {
  x: number;
  y: number;
}

export interface TopologySnapshot {
  revision: string;
  refreshedAt: string;
  stats: TopologyStats;
  nodes: TopologyNode[];
  links: TopologyLink[];
  clusters: EndpointCluster[];
  layoutPositions: Record<string, TopologyPosition>;
  warnings: TopologyWarning[];
  sourceType?: "nvue" | "ports-csv";
}

export interface TopologySummary {
  id: string;
  projectId: string;
  name: string;
  sourceType: "nvue" | "ports-csv";
  nodeCount: number;
  linkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TopologyProject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  topologies: TopologySummary[];
}

export const DEVICE_ROLES: DeviceRole[] = [
  "CSW",
  "SSW",
  "ASW",
  "HSS",
  "MGMT",
  "LSW",
  "SOOB",
  "OOB",
  "IBCR",
  "IBSP",
  "IBLF",
  "SERVER",
  "ENDPOINT",
  "UNKNOWN",
];

export const POD_NAMES: PodName[] = ["POD1", "POD2", "POD3", "SHARED", "UNKNOWN"];
