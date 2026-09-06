export type ForwardingStatus = "up" | "down";
export type InterfaceType = "physical" | "logical" | "svi" | "lag" | "vxlan";
export type ForwardingMode = "routed" | "access" | "trunk";
export type RouteAction = "forward" | "connected" | "local" | "drop" | "vxlan";
export type MacAction = "interface" | "remote" | "drop";
export type VxlanMode = "l2" | "l3";

export interface ForwardingWorkbookLocation {
  row: number;
  sourceFile?: string;
}

export interface ForwardingMetadata {
  templateVersion: string;
  batchName: string;
  collectedAt: string;
  note?: string;
}

export interface ForwardingInterface extends ForwardingWorkbookLocation {
  deviceId: string;
  deviceName: string;
  interfaceName: string;
  interfaceType: InterfaceType;
  forwardingMode: ForwardingMode;
  vrf: string;
  vlan?: number;
  allowedVlans: number[];
  bridge?: string;
  mac?: string;
  status: ForwardingStatus;
}

export interface ForwardingLagMember extends ForwardingWorkbookLocation {
  deviceId: string;
  deviceName: string;
  aggregateInterface: string;
  memberInterface: string;
  status: ForwardingStatus;
}

export interface ForwardingRoute extends ForwardingWorkbookLocation {
  deviceId: string;
  deviceName: string;
  vrf: string;
  destinationCidr: string;
  action: RouteAction;
  nextHop?: string;
  outputInterface?: string;
  ecmpGroup?: string;
  vni?: number;
  remoteVtep?: string;
}

export interface ForwardingArp extends ForwardingWorkbookLocation {
  deviceId: string;
  deviceName: string;
  vrf: string;
  ip: string;
  mac: string;
  interfaceName: string;
  status: "reachable" | "stale" | "static" | "incomplete";
}

export interface ForwardingMac extends ForwardingWorkbookLocation {
  deviceId: string;
  deviceName: string;
  vlan: number;
  mac: string;
  action: MacAction;
  outputInterface?: string;
  vni?: number;
  remoteVtep?: string;
}

export interface ForwardingVxlan extends ForwardingWorkbookLocation {
  deviceId: string;
  deviceName: string;
  vni: number;
  mode: VxlanMode;
  localVtep: string;
  vlan?: number;
  tenantVrf?: string;
  underlayVrf: string;
  udpDestinationPort: number;
  status: ForwardingStatus;
}

export interface ForwardingSnapshotData {
  metadata: ForwardingMetadata;
  interfaces: ForwardingInterface[];
  lagMembers: ForwardingLagMember[];
  routes: ForwardingRoute[];
  arpEntries: ForwardingArp[];
  macEntries: ForwardingMac[];
  vxlanEntries: ForwardingVxlan[];
}

export interface ForwardingSnapshotSummary {
  id: string;
  topologyId: string;
  batchName: string;
  templateVersion: string;
  collectedAt: string;
  importedAt: string;
  note?: string;
  isDefault: boolean;
  compatible: boolean;
  compatibilityReason?: string;
  counts: {
    interfaces: number;
    lagMembers: number;
    routes: number;
    arpEntries: number;
    macEntries: number;
    vxlanEntries: number;
  };
}

export interface ForwardingImportIssue {
  sourceFile?: string;
  sheet: string;
  row: number;
  column: string;
  message: string;
}

export interface ForwardingTraceRequest {
  sourceDeviceId: string;
  sourceIp: string;
  destinationIp: string;
  sourceInterface?: string;
  vrf?: string;
}

export interface AbstractPacket {
  innerSourceIp: string;
  innerDestinationIp: string;
  vrf?: string;
  vlan?: number;
  vxlan?: {
    mode: VxlanMode;
    vni: number;
    outerSourceVtep: string;
    outerDestinationVtep: string;
    udpDestinationPort: number;
    underlayVrf: string;
  };
}

export type TraceStateKind = "ingress" | "lookup" | "encapsulate" | "decapsulate" | "egress" | "terminal";

export interface ForwardingTraceState {
  id: string;
  deviceId: string;
  deviceName: string;
  ingressInterface?: string;
  kind: TraceStateKind;
  packet: AbstractPacket;
  summary: string;
  evidence?: Array<{
    sourceFile?: string;
    sheet: string;
    row: number;
    description: string;
  }>;
}

export interface ForwardingTraceTransition {
  id: string;
  fromStateId: string;
  toStateId: string;
  fromDeviceId: string;
  toDeviceId: string;
  outputInterface: string;
  inputInterface: string;
  topologyLinkId: string;
  summary: string;
}

export type TraceTerminationCode =
  | "DELIVERED"
  | "NO_ROUTE"
  | "NO_ARP"
  | "NO_MAC"
  | "NO_VXLAN"
  | "NO_LINK"
  | "INTERFACE_DOWN"
  | "EXPLICIT_DROP"
  | "AMBIGUOUS_SOURCE"
  | "LOOP_DETECTED"
  | "VTEP_UNREACHABLE"
  | "INVALID_STATE";

export interface ForwardingTraceEndpoint {
  stateId: string;
  deviceId: string;
  code: TraceTerminationCode;
  message: string;
}

export interface ForwardingTraceResult {
  snapshotId: string;
  topologyId: string;
  source: ForwardingTraceRequest;
  states: ForwardingTraceState[];
  transitions: ForwardingTraceTransition[];
  endpoints: ForwardingTraceEndpoint[];
  rootStateId: string;
  createdAt: string;
}
