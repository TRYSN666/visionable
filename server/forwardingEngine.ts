import { isIP } from "node:net";
import type {
  AbstractPacket,
  ForwardingRoute,
  ForwardingSnapshotData,
  ForwardingTraceEndpoint,
  ForwardingTraceRequest,
  ForwardingTraceResult,
  ForwardingTraceState,
  ForwardingTraceTransition,
  ForwardingVxlan,
  TraceTerminationCode,
} from "../shared/forwarding.js";
import type { TopologyLink, TopologySnapshot } from "../shared/topology.js";

const DEFAULT_VRF = "default";

function norm(value: string): string {
  return value.trim().toLowerCase();
}

function ipNumber(address: string): number {
  return address.split(".").reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
}

function cidrContains(cidr: string, address: string): boolean {
  const [network, rawPrefix] = cidr.split("/");
  const prefix = Number(rawPrefix);
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber(network) & mask) === (ipNumber(address) & mask);
}

function prefixLength(cidr: string): number {
  return Number(cidr.split("/")[1]);
}

function packetCopy(packet: AbstractPacket): AbstractPacket {
  return { ...packet, vxlan: packet.vxlan ? { ...packet.vxlan } : undefined };
}

interface WorkState {
  deviceId: string;
  ingressInterface?: string;
  packet: AbstractPacket;
  destinationMac?: string;
}

interface QueueItem {
  stateId: string;
  work: WorkState;
  ancestors: Set<string>;
}

interface LinkExit {
  link: TopologyLink;
  remoteDeviceId: string;
  remoteInterface: string;
  localInterface: string;
}

function stateKey(state: WorkState): string {
  const outer = state.packet.vxlan;
  return [
    state.deviceId,
    norm(state.ingressInterface ?? ""),
    norm(state.packet.vrf ?? DEFAULT_VRF),
    state.packet.vlan ?? "",
    state.destinationMac ?? "",
    outer?.mode ?? "",
    outer?.vni ?? "",
    outer?.outerSourceVtep ?? "",
    outer?.outerDestinationVtep ?? "",
    outer?.underlayVrf ?? "",
  ].join("\0");
}

function routeCandidates(data: ForwardingSnapshotData, deviceId: string, vrf: string, destination: string): ForwardingRoute[] {
  const matches = data.routes.filter((route) => route.deviceId === deviceId && norm(route.vrf) === norm(vrf) && cidrContains(route.destinationCidr, destination));
  if (matches.length === 0) return [];
  const longest = Math.max(...matches.map((route) => prefixLength(route.destinationCidr)));
  return matches.filter((route) => prefixLength(route.destinationCidr) === longest);
}

function sourceInterfaces(topology: TopologySnapshot, data: ForwardingSnapshotData, request: ForwardingTraceRequest): Array<{ name: string; vrf: string }> {
  const node = topology.nodes.find((item) => item.id === request.sourceDeviceId);
  if (!node) return [];
  const matchingTopologyInterfaces = node.interfaces.filter((item) => item.addresses.some((address) => address.cidr.split("/")[0] === request.sourceIp));
  let candidates = matchingTopologyInterfaces.flatMap((item) => {
    const attributes = data.interfaces.filter((attribute) => attribute.deviceId === node.id && norm(attribute.interfaceName) === norm(item.name) && attribute.status === "up");
    return attributes.length > 0 ? attributes.map((attribute) => ({ name: item.name, vrf: attribute.vrf })) : [{ name: item.name, vrf: request.vrf ?? DEFAULT_VRF }];
  });
  if (request.sourceInterface) candidates = candidates.filter((item) => norm(item.name) === norm(request.sourceInterface!));
  if (request.vrf) candidates = candidates.filter((item) => norm(item.vrf) === norm(request.vrf!));
  if (candidates.length === 0) {
    candidates = data.interfaces
      .filter((item) => item.deviceId === node.id && item.status === "up" && (!request.sourceInterface || norm(item.interfaceName) === norm(request.sourceInterface)) && (!request.vrf || norm(item.vrf) === norm(request.vrf)))
      .map((item) => ({ name: item.interfaceName, vrf: item.vrf }));
  }
  const unique = new Map(candidates.map((item) => [`${norm(item.name)}\0${norm(item.vrf)}`, item]));
  return [...unique.values()];
}

export function traceForwarding(topologyId: string, snapshotId: string, topology: TopologySnapshot, data: ForwardingSnapshotData, request: ForwardingTraceRequest): ForwardingTraceResult {
  if (isIP(request.sourceIp) !== 4 || isIP(request.destinationIp) !== 4) throw new Error("源IP和目的IP必须是 IPv4 地址");
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  const sourceNode = nodeById.get(request.sourceDeviceId);
  if (!sourceNode) throw new Error("源设备不在当前拓扑中");

  const states: ForwardingTraceState[] = [];
  const transitions: ForwardingTraceTransition[] = [];
  const endpoints: ForwardingTraceEndpoint[] = [];
  const stateByKey = new Map<string, string>();
  const queue: QueueItem[] = [];
  let stateSequence = 0;
  let transitionSequence = 0;

  const createState = (work: WorkState, kind: ForwardingTraceState["kind"], summary: string): string => {
    const id = `state-${++stateSequence}`;
    const node = nodeById.get(work.deviceId);
    states.push({ id, deviceId: work.deviceId, deviceName: node?.hostname ?? work.deviceId, ingressInterface: work.ingressInterface, kind, packet: packetCopy(work.packet), summary });
    return id;
  };
  const terminate = (stateId: string, deviceId: string, code: TraceTerminationCode, message: string): void => {
    const state = states.find((item) => item.id === stateId)!;
    state.kind = "terminal";
    state.summary = message;
    endpoints.push({ stateId, deviceId, code, message });
  };
  const evidence = (stateId: string, sheet: string, row: number, description: string, sourceFile?: string): void => {
    const state = states.find((item) => item.id === stateId)!;
    state.evidence = [...(state.evidence ?? []), { sourceFile, sheet, row, description }];
  };

  const interfaceAttribute = (deviceId: string, interfaceName: string) => data.interfaces.find((item) => item.deviceId === deviceId && norm(item.interfaceName) === norm(interfaceName));
  const physicalExits = (deviceId: string, interfaceName: string): LinkExit[] => {
    const attribute = interfaceAttribute(deviceId, interfaceName);
    if (attribute?.status === "down") return [];
    const physicalNames = attribute?.interfaceType === "lag"
      ? data.lagMembers.filter((member) => member.deviceId === deviceId && norm(member.aggregateInterface) === norm(interfaceName) && member.status === "up").map((member) => member.memberInterface)
      : [interfaceName];
    return physicalNames.flatMap((physicalName) => topology.links.flatMap((link): LinkExit[] => {
      if (link.source === deviceId && norm(link.sourceInterface) === norm(physicalName)) return [{ link, remoteDeviceId: link.target, remoteInterface: link.targetInterface, localInterface: physicalName }];
      if (link.target === deviceId && norm(link.targetInterface) === norm(physicalName)) return [{ link, remoteDeviceId: link.source, remoteInterface: link.sourceInterface, localInterface: physicalName }];
      return [];
    }));
  };

  const enqueueExit = (item: QueueItem, outputInterface: string, packet: AbstractPacket, destinationMac: string | undefined, summary: string): void => {
    const attribute = interfaceAttribute(item.work.deviceId, outputInterface);
    if (attribute?.status === "down") {
      terminate(item.stateId, item.work.deviceId, "INTERFACE_DOWN", `出接口 ${outputInterface} 状态为 down`);
      return;
    }
    const exits = physicalExits(item.work.deviceId, outputInterface);
    if (exits.length === 0) {
      terminate(item.stateId, item.work.deviceId, "NO_LINK", `出接口 ${outputInterface} 没有状态为 up 的物理链路或 LAG 成员`);
      return;
    }
    const fromState = states.find((state) => state.id === item.stateId)!;
    if (fromState.kind !== "encapsulate" && fromState.kind !== "decapsulate") fromState.kind = "egress";
    fromState.summary = fromState.kind === "encapsulate" || fromState.kind === "decapsulate" ? `${fromState.summary}；${summary}` : summary;
    for (const exit of exits) {
      const next: WorkState = { deviceId: exit.remoteDeviceId, ingressInterface: exit.remoteInterface, packet: packetCopy(packet), destinationMac };
      const key = stateKey(next);
      let nextStateId = stateByKey.get(key);
      if (item.ancestors.has(key)) {
        nextStateId = createState(next, "terminal", `检测到转发循环：再次到达 ${nodeById.get(next.deviceId)?.hostname ?? next.deviceId}`);
        endpoints.push({ stateId: nextStateId, deviceId: next.deviceId, code: "LOOP_DETECTED", message: "检测到重复转发状态，已终止该分支" });
      } else if (!nextStateId) {
        nextStateId = createState(next, "ingress", `从 ${exit.remoteInterface} 到达设备`);
        stateByKey.set(key, nextStateId);
        queue.push({ stateId: nextStateId, work: next, ancestors: new Set([...item.ancestors, key]) });
      }
      transitions.push({
        id: `transition-${++transitionSequence}`,
        fromStateId: item.stateId,
        toStateId: nextStateId,
        fromDeviceId: item.work.deviceId,
        toDeviceId: exit.remoteDeviceId,
        outputInterface: exit.localInterface,
        inputInterface: exit.remoteInterface,
        topologyLinkId: exit.link.id,
        summary,
      });
    }
  };

  const vxlanMapping = (deviceId: string, vni: number, mode?: "l2" | "l3"): ForwardingVxlan | undefined => data.vxlanEntries.find((entry) => entry.deviceId === deviceId && entry.vni === vni && entry.status === "up" && (!mode || entry.mode === mode));

  const encapsulate = (item: QueueItem, mapping: ForwardingVxlan, mode: "l2" | "l3", remoteVtep: string, destinationMac: string | undefined, origin: { sheet: string; row: number; sourceFile?: string }): void => {
    const packet: AbstractPacket = {
      ...packetCopy(item.work.packet),
      vxlan: {
        mode,
        vni: mapping.vni,
        outerSourceVtep: mapping.localVtep,
        outerDestinationVtep: remoteVtep,
        udpDestinationPort: mapping.udpDestinationPort,
        underlayVrf: mapping.underlayVrf,
      },
    };
    const state = states.find((entry) => entry.id === item.stateId)!;
    state.kind = "encapsulate";
    state.packet = packetCopy(packet);
    evidence(item.stateId, origin.sheet, origin.row, `${mode.toUpperCase()}VNI ${mapping.vni} 封装到 ${remoteVtep}`, origin.sourceFile);
    const underlay = routeCandidates(data, item.work.deviceId, mapping.underlayVrf, remoteVtep);
    if (underlay.length === 0) {
      terminate(item.stateId, item.work.deviceId, "VTEP_UNREACHABLE", `Underlay VRF ${mapping.underlayVrf} 中没有到远端 VTEP ${remoteVtep} 的路由`);
      return;
    }
    for (const route of underlay) forwardRoute(item, route, packet, destinationMac, true);
  };

  const forwardMac = (item: QueueItem, mac: string, vlan: number, packet: AbstractPacket): void => {
    const entry = data.macEntries.find((candidate) => candidate.deviceId === item.work.deviceId && candidate.vlan === vlan && candidate.mac === mac);
    if (!entry) {
      terminate(item.stateId, item.work.deviceId, "NO_MAC", `VLAN ${vlan} 中没有目的 MAC ${mac} 的已知单播表项`);
      return;
    }
    evidence(item.stateId, "MAC表", entry.row, `VLAN ${vlan} 的 ${mac} 命中 ${entry.action}`, entry.sourceFile);
    if (entry.action === "drop") {
      terminate(item.stateId, item.work.deviceId, "EXPLICIT_DROP", `MAC 表显式丢弃 ${mac}`);
      return;
    }
    if (entry.action === "remote") {
      const mapping = entry.vni === undefined ? undefined : vxlanMapping(item.work.deviceId, entry.vni, "l2");
      if (!mapping || !entry.remoteVtep) {
        terminate(item.stateId, item.work.deviceId, "NO_VXLAN", `缺少 VLAN ${vlan} 对应的 L2VNI 映射`);
        return;
      }
      encapsulate(item, mapping, "l2", entry.remoteVtep, mac, { sheet: "MAC表", row: entry.row, sourceFile: entry.sourceFile });
      return;
    }
    if (!entry.outputInterface) {
      terminate(item.stateId, item.work.deviceId, "INVALID_STATE", "MAC 表接口动作缺少出接口");
      return;
    }
    enqueueExit(item, entry.outputInterface, { ...packetCopy(packet), vlan }, mac, `MAC ${mac} 从 ${entry.outputInterface} 转发`);
  };

  function forwardRoute(item: QueueItem, route: ForwardingRoute, packet: AbstractPacket, destinationMac: string | undefined, outerLookup: boolean): void {
    evidence(item.stateId, "路由表", route.row, `${route.vrf} 中 ${route.destinationCidr} 命中 ${route.action}${route.ecmpGroup ? `（ECMP ${route.ecmpGroup}）` : ""}`, route.sourceFile);
    if (route.action === "drop") {
      terminate(item.stateId, item.work.deviceId, "EXPLICIT_DROP", `路由 ${route.destinationCidr} 显式丢弃`);
      return;
    }
    if (route.action === "local") {
      if (outerLookup) terminate(item.stateId, item.work.deviceId, "VTEP_UNREACHABLE", "Underlay 路由终止于本地，但未找到匹配的 VXLAN 终结点");
      else terminate(item.stateId, item.work.deviceId, "DELIVERED", `目的地址 ${packet.innerDestinationIp} 已到达本设备`);
      return;
    }
    if (route.action === "vxlan") {
      if (outerLookup) {
        terminate(item.stateId, item.work.deviceId, "INVALID_STATE", "不支持嵌套 VXLAN");
        return;
      }
      const mapping = route.vni === undefined ? undefined : vxlanMapping(item.work.deviceId, route.vni, "l3");
      if (!mapping || !route.remoteVtep) {
        terminate(item.stateId, item.work.deviceId, "NO_VXLAN", `路由引用的 L3VNI ${route.vni ?? "(空)"} 不可用`);
        return;
      }
      encapsulate(item, mapping, "l3", route.remoteVtep, destinationMac, { sheet: "路由表", row: route.row, sourceFile: route.sourceFile });
      return;
    }
    if (!route.outputInterface) {
      terminate(item.stateId, item.work.deviceId, "INVALID_STATE", `路由 ${route.destinationCidr} 缺少出接口`);
      return;
    }
    const targetIp = route.nextHop ?? (outerLookup ? packet.vxlan!.outerDestinationVtep : packet.innerDestinationIp);
    const arp = data.arpEntries.find((entry) => entry.deviceId === item.work.deviceId && norm(entry.vrf) === norm(route.vrf) && entry.ip === targetIp && entry.status !== "incomplete");
    if (!arp) {
      terminate(item.stateId, item.work.deviceId, "NO_ARP", `${route.vrf} 中缺少下一跳 ${targetIp} 的可用 ARP`);
      return;
    }
    evidence(item.stateId, "ARP表", arp.row, `${targetIp} 解析为 ${arp.mac}`, arp.sourceFile);
    const outputAttribute = interfaceAttribute(item.work.deviceId, route.outputInterface);
    const routedEgress = outputAttribute?.forwardingMode === "routed";
    if (routedEgress) {
      enqueueExit(item, route.outputInterface, packet, outerLookup ? destinationMac : arp.mac, `${targetIp} 经 ${route.outputInterface} 转发`);
      return;
    }
    const arpInterface = interfaceAttribute(item.work.deviceId, arp.interfaceName);
    const vlan = arpInterface?.vlan ?? outputAttribute?.vlan ?? packet.vlan;
    if (vlan === undefined) {
      terminate(item.stateId, item.work.deviceId, "INVALID_STATE", `接口 ${arp.interfaceName} 缺少 VLAN，无法查询 MAC 表`);
      return;
    }
    forwardMac(item, arp.mac, vlan, packet);
  }

  const choices = sourceInterfaces(topology, data, request);
  const packet: AbstractPacket = { innerSourceIp: request.sourceIp, innerDestinationIp: request.destinationIp, vrf: request.vrf ?? choices[0]?.vrf ?? DEFAULT_VRF };
  const rootWork: WorkState = { deviceId: sourceNode.id, packet };
  const rootStateId = createState(rootWork, "ingress", `从 ${sourceNode.hostname} 发起模拟流量`);
  const rootKey = stateKey(rootWork);
  stateByKey.set(rootKey, rootStateId);
  queue.push({ stateId: rootStateId, work: rootWork, ancestors: new Set([rootKey]) });

  if (choices.length > 1 && !request.sourceInterface && !request.vrf) {
    terminate(rootStateId, sourceNode.id, "AMBIGUOUS_SOURCE", "源地址归属多个接口或 VRF，请补充源接口或 VRF");
    queue.length = 0;
  }

  while (queue.length > 0) {
    const item = queue.shift()!;
    const publicState = states.find((state) => state.id === item.stateId)!;
    let packetAtDevice = packetCopy(item.work.packet);
    let destinationMac = item.work.destinationMac;

    if (packetAtDevice.vxlan) {
      const outer = packetAtDevice.vxlan;
      const local = data.vxlanEntries.find((entry) => entry.deviceId === item.work.deviceId && entry.vni === outer.vni && entry.localVtep === outer.outerDestinationVtep && entry.mode === outer.mode && entry.status === "up");
      if (local) {
        evidence(item.stateId, "VXLAN", local.row, `终结 ${outer.mode.toUpperCase()}VNI ${outer.vni}`, local.sourceFile);
        publicState.kind = "decapsulate";
        publicState.summary = `${outer.outerDestinationVtep} 解封装 ${outer.mode.toUpperCase()}VNI ${outer.vni}`;
        packetAtDevice = { ...packetAtDevice, vxlan: undefined, vrf: local.mode === "l3" ? local.tenantVrf : packetAtDevice.vrf, vlan: local.mode === "l2" ? local.vlan : undefined };
        publicState.packet = packetCopy(packetAtDevice);
        if (local.mode === "l2") {
          if (!destinationMac) {
            const arp = data.arpEntries.find((entry) => entry.deviceId === item.work.deviceId && entry.ip === packetAtDevice.innerDestinationIp && entry.status !== "incomplete");
            destinationMac = arp?.mac;
            if (arp) evidence(item.stateId, "ARP表", arp.row, `${arp.ip} 解析为 ${arp.mac}`, arp.sourceFile);
          }
          if (!destinationMac || local.vlan === undefined) terminate(item.stateId, item.work.deviceId, destinationMac ? "NO_VXLAN" : "NO_ARP", destinationMac ? "L2VNI 缺少 VLAN 映射" : `解封装后缺少 ${packetAtDevice.innerDestinationIp} 的 ARP`);
          else forwardMac({ ...item, work: { ...item.work, packet: packetAtDevice, destinationMac } }, destinationMac, local.vlan, packetAtDevice);
          continue;
        }
      } else {
        const underlay = routeCandidates(data, item.work.deviceId, outer.underlayVrf, outer.outerDestinationVtep);
        if (underlay.length === 0) terminate(item.stateId, item.work.deviceId, "NO_ROUTE", `Underlay VRF ${outer.underlayVrf} 中没有到 ${outer.outerDestinationVtep} 的路由`);
        else for (const route of underlay) forwardRoute(item, route, packetAtDevice, destinationMac, true);
        continue;
      }
    }

    const localAddress = nodeById.get(item.work.deviceId)?.interfaces.some((networkInterface) => networkInterface.addresses.some((address) => address.cidr.split("/")[0] === packetAtDevice.innerDestinationIp));
    if (localAddress) {
      terminate(item.stateId, item.work.deviceId, "DELIVERED", `目的地址 ${packetAtDevice.innerDestinationIp} 已到达 ${publicState.deviceName}`);
      continue;
    }
    const vrf = packetAtDevice.vrf ?? DEFAULT_VRF;
    const routes = routeCandidates(data, item.work.deviceId, vrf, packetAtDevice.innerDestinationIp);
    if (routes.length === 0) {
      const nodeRoutes = data.routes.some((route) => route.deviceId === item.work.deviceId);
      const exits = topology.links.flatMap((link): LinkExit[] => {
        if (link.source === item.work.deviceId) return [{ link, remoteDeviceId: link.target, remoteInterface: link.targetInterface, localInterface: link.sourceInterface }];
        if (link.target === item.work.deviceId) return [{ link, remoteDeviceId: link.source, remoteInterface: link.sourceInterface, localInterface: link.targetInterface }];
        return [];
      });
      if (!nodeRoutes && sourceNode.id === item.work.deviceId && transitions.length === 0 && exits.length === 1) {
        enqueueExit(item, exits[0].localInterface, packetAtDevice, destinationMac, `源终端从 ${exits[0].localInterface} 注入流量`);
      } else {
        terminate(item.stateId, item.work.deviceId, "NO_ROUTE", `${vrf} 中没有到 ${packetAtDevice.innerDestinationIp} 的路由`);
      }
      continue;
    }
    publicState.kind = "lookup";
    for (const route of routes) forwardRoute(item, route, packetAtDevice, destinationMac, false);
  }

  return { snapshotId, topologyId, source: request, states, transitions, endpoints, rootStateId, createdAt: new Date().toISOString() };
}
