import { ChevronRight, CircleAlert, Pencil, Pin, RotateCcw, Save, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ForwardingSnapshotData, ForwardingSnapshotSummary } from "../shared/forwarding";
import type { TopologyLink, TopologyNode } from "../shared/topology";
import type { GraphEdgeData, GraphNodeData } from "./graphModel";

interface InspectorProps {
  graphNode?: GraphNodeData;
  edge?: GraphEdgeData;
  nodeById: Map<string, TopologyNode>;
  projectId?: string;
  topologyId?: string;
  topologyLinks?: TopologyLink[];
  pinned: boolean;
  savingAddress: boolean;
  onSaveServerAddresses: (hostname: string, values: { inBandIp: string; outOfBandIp: string }) => Promise<void>;
  onResetServerAddresses: (hostname: string) => Promise<void>;
  onHighlightLinks?: (linkIds: ReadonlySet<string>) => void;
  onClose: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function Inspector({ graphNode, edge, nodeById, projectId, topologyId, topologyLinks = [], pinned, savingAddress, onSaveServerAddresses, onResetServerAddresses, onHighlightLinks, onClose, onMouseEnter, onMouseLeave }: InspectorProps) {
  if (!graphNode && !edge) return null;

  if (edge) {
    return (
      <aside className="inspector edge-inspector" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} aria-live="polite">
        <div className="inspector-heading">
          <div><p>聚合链路</p><h2>{edge.count} 条物理连接</h2></div>
          <button type="button" onClick={onClose} aria-label="关闭链路详情"><X size={16} /></button>
        </div>
        <div className="edge-list">
          {edge.members.map((link) => (
            <div className="edge-row" key={link.id}>
              <div><strong>{nodeById.get(link.source)?.label ?? link.source}</strong><span>{link.sourceInterface}</span></div>
              <ChevronRight size={14} />
              <div><strong>{nodeById.get(link.target)?.label ?? link.target}</strong><span>{link.targetInterface}</span></div>
              <b>{link.bandwidth ?? "未知速率"}</b>
            </div>
          ))}
        </div>
      </aside>
    );
  }

  if (!graphNode) return null;
  if (graphNode.kind === "cluster") {
    return (
      <aside className="inspector" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} aria-live="polite">
        <div className="inspector-heading">
          <div><p>{graphNode.cluster?.endpointType === "GPU" ? "GPU 分组" : "终端簇"}</p><h2>{graphNode.label}</h2></div>
          <button type="button" onClick={onClose} aria-label="关闭终端簇详情"><X size={16} /></button>
        </div>
        <div className="cluster-summary"><strong>{graphNode.memberCount}</strong><span>台外部终端</span></div>
        <dl className="metadata"><div><dt>POD</dt><dd>{graphNode.pod}</dd></div><div><dt>机柜</dt><dd>{graphNode.cluster?.rack}</dd></div><div><dt>类型</dt><dd>{graphNode.cluster?.endpointType}</dd></div></dl>
        <p className="inspector-hint">{graphNode.cluster?.endpointType === "GPU" ? `点击该分组可展开或收起 ${graphNode.pod} 的全部 GPU。` : "点击拓扑中的六边形节点展开终端；展开后可逐台查看接口。"}</p>
      </aside>
    );
  }

  const node = graphNode.node;
  if (!node) return null;
  return (
    <DeviceInspector
      key={node.id}
      node={node}
      projectId={projectId}
      topologyId={topologyId}
      topologyLinks={topologyLinks}
      pinned={pinned}
      savingAddress={savingAddress}
      onSaveServerAddresses={onSaveServerAddresses}
      onResetServerAddresses={onResetServerAddresses}
      onHighlightLinks={onHighlightLinks}
      onClose={onClose}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    />
  );
}

type DeviceTab = "physical" | "aggregate" | "forwarding";
type ForwardingTab = "route" | "arp" | "mac" | "vxlan";

interface DeviceInspectorProps extends Pick<InspectorProps, "projectId" | "topologyId" | "topologyLinks" | "pinned" | "savingAddress" | "onSaveServerAddresses" | "onResetServerAddresses" | "onHighlightLinks" | "onClose" | "onMouseEnter" | "onMouseLeave"> {
  node: TopologyNode;
}

function snapshotApi(projectId: string, topologyId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/topologies/${encodeURIComponent(topologyId)}/forwarding-snapshots`;
}

function forwardingText(value: object): string {
  return Object.values(value).filter((item) => item !== undefined && item !== null).join(" ").toLowerCase();
}

export function topologyLinkIdsForInterfaces(nodeId: string, names: string[], topologyLinks: TopologyLink[]): ReadonlySet<string> {
  const normalizedNames = new Set(names.map((name) => name.toLowerCase()));
  return new Set(topologyLinks.filter((link) =>
    link.source === nodeId && normalizedNames.has(link.sourceInterface.toLowerCase()) ||
    link.target === nodeId && normalizedNames.has(link.targetInterface.toLowerCase()),
  ).map((link) => link.id));
}

function DeviceInspector({ node, projectId, topologyId, topologyLinks = [], pinned, savingAddress, onSaveServerAddresses, onResetServerAddresses, onHighlightLinks, onClose, onMouseEnter, onMouseLeave }: DeviceInspectorProps) {
  const [deviceTab, setDeviceTab] = useState<DeviceTab>("physical");
  const [forwardingTab, setForwardingTab] = useState<ForwardingTab>("route");
  const [forwardingQuery, setForwardingQuery] = useState("");
  const [forwardingData, setForwardingData] = useState<ForwardingSnapshotData>();
  const [forwardingLoading, setForwardingLoading] = useState(false);
  const [forwardingError, setForwardingError] = useState<string>();
  const [selectedInterface, setSelectedInterface] = useState<string>();
  const [onlyIp, setOnlyIp] = useState(false);
  const [editing, setEditing] = useState(false);
  const [inBandIp, setInBandIp] = useState(node.serverInfo?.inBandIp ?? "");
  const [outOfBandIp, setOutOfBandIp] = useState(node.serverInfo?.outOfBandIp ?? "");

  useEffect(() => {
    if (!projectId || !topologyId) return;
    let cancelled = false;
    const load = async () => {
      setForwardingLoading(true);
      setForwardingError(undefined);
      try {
        const base = snapshotApi(projectId, topologyId);
        const listResponse = await fetch(base, { headers: { Accept: "application/json" } });
        const list = await listResponse.json() as { snapshots?: ForwardingSnapshotSummary[]; defaultSnapshotId?: string; error?: string };
        if (!listResponse.ok || !list.snapshots) throw new Error(list.error ?? "无法读取转发表快照");
        const snapshotId = list.defaultSnapshotId ?? list.snapshots.find((item) => item.compatible)?.id;
        if (!snapshotId) {
          if (!cancelled) setForwardingData(undefined);
          return;
        }
        const detailResponse = await fetch(`${base}/${encodeURIComponent(snapshotId)}`, { headers: { Accept: "application/json" } });
        const detail = await detailResponse.json() as ForwardingSnapshotData | { error?: string };
        if (!detailResponse.ok || !("metadata" in detail)) throw new Error("error" in detail ? detail.error : "无法读取转发表明细");
        if (!cancelled) setForwardingData(detail);
      } catch (error) {
        if (!cancelled) setForwardingError(error instanceof Error ? error.message : "无法读取转发表明细");
      } finally {
        if (!cancelled) setForwardingLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [projectId, topologyId]);

  const deviceInterfaces = useMemo(() => forwardingData?.interfaces.filter((item) => item.deviceId === node.id) ?? [], [forwardingData, node.id]);
  const deviceLagMembers = useMemo(() => forwardingData?.lagMembers.filter((item) => item.deviceId === node.id) ?? [], [forwardingData, node.id]);
  const aggregateNames = useMemo(() => new Set([
    ...deviceInterfaces.filter((item) => item.interfaceType === "lag").map((item) => item.interfaceName.toLowerCase()),
    ...deviceLagMembers.map((item) => item.aggregateInterface.toLowerCase()),
  ]), [deviceInterfaces, deviceLagMembers]);
  const connectedNames = useMemo(() => new Set(topologyLinks.flatMap((link) => link.source === node.id ? [link.sourceInterface.toLowerCase()] : link.target === node.id ? [link.targetInterface.toLowerCase()] : [])), [node.id, topologyLinks]);
  const physicalInterfaces = node.interfaces.filter((item) => !aggregateNames.has(item.name.toLowerCase()) && (!item.logical || connectedNames.has(item.name.toLowerCase())));
  const logicalInterfaces = node.interfaces.filter((item) => !aggregateNames.has(item.name.toLowerCase()) && item.logical && !connectedNames.has(item.name.toLowerCase()));
  const visiblePhysical = onlyIp ? physicalInterfaces.filter((item) => item.addresses.length > 0) : physicalInterfaces;
  const visibleLogical = onlyIp ? logicalInterfaces.filter((item) => item.addresses.length > 0) : logicalInterfaces;
  const aggregateInterfaces = useMemo(() => {
    const names = new Map<string, string>();
    for (const item of deviceInterfaces) if (item.interfaceType === "lag") names.set(item.interfaceName.toLowerCase(), item.interfaceName);
    for (const item of deviceLagMembers) names.set(item.aggregateInterface.toLowerCase(), item.aggregateInterface);
    return [...names.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((name) => ({
      name,
      members: deviceLagMembers.filter((item) => item.aggregateInterface.toLowerCase() === name.toLowerCase()),
      attributes: deviceInterfaces.find((item) => item.interfaceName.toLowerCase() === name.toLowerCase()),
    }));
  }, [deviceInterfaces, deviceLagMembers]);

  const linksForInterfaces = (names: string[]): ReadonlySet<string> => {
    return topologyLinkIdsForInterfaces(node.id, names, topologyLinks);
  };

  const highlightInterfaces = (label: string, names: string[]) => {
    setSelectedInterface(label);
    onHighlightLinks?.(linksForInterfaces(names));
  };

  const switchDeviceTab = (tab: DeviceTab) => {
    setDeviceTab(tab);
    setSelectedInterface(undefined);
    onHighlightLinks?.(new Set());
  };

  const save = async () => {
    try {
      await onSaveServerAddresses(node.hostname, { inBandIp, outOfBandIp });
      setEditing(false);
    } catch {
      // The parent surfaces the request error while keeping the form open for correction.
    }
  };

  const reset = async () => {
    try {
      await onResetServerAddresses(node.hostname);
      setInBandIp(node.serverInfo?.inventoryInBandIp ?? "");
      setOutOfBandIp(node.serverInfo?.inventoryOutOfBandIp ?? "");
      setEditing(false);
    } catch {
      // The parent surfaces the request error.
    }
  };

  const query = forwardingQuery.trim().toLowerCase();
  const routes = (forwardingData?.routes ?? []).filter((item) => item.deviceId === node.id && (!query || forwardingText(item).includes(query)));
  const arpEntries = (forwardingData?.arpEntries ?? []).filter((item) => item.deviceId === node.id && (!query || forwardingText(item).includes(query)));
  const macEntries = (forwardingData?.macEntries ?? []).filter((item) => item.deviceId === node.id && (!query || forwardingText(item).includes(query)));
  const vxlanEntries = (forwardingData?.vxlanEntries ?? []).filter((item) => item.deviceId === node.id && (!query || forwardingText(item).includes(query)));
  const tableRows = forwardingTab === "route" ? routes : forwardingTab === "arp" ? arpEntries : forwardingTab === "mac" ? macEntries : vxlanEntries;

  return (
    <aside className="inspector" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} aria-live="polite">
      <div className="inspector-heading">
        <div>
          <p>{node.kind === "configured" ? "网络设备" : node.endpointType === "GPU" || node.role === "SERVER" ? "服务器" : "外部终端"} · {node.role}</p>
          <h2>{node.label}</h2>
        </div>
        <div className="inspector-actions">{pinned && <Pin size={14} aria-label="详情已固定" />}<button type="button" onClick={onClose} aria-label="关闭设备详情"><X size={16} /></button></div>
      </div>
      <p className="hostname">{node.hostname}</p>
      <dl className="metadata">
        <div><dt>POD</dt><dd>{node.pod}</dd></div>
        <div><dt>机柜</dt><dd>{node.rack ?? "未识别"}</dd></div>
        <div><dt>管理 IP</dt><dd>{node.managementIp ?? "配置未提供"}</dd></div>
      </dl>
      {node.lids && node.lids.length > 0 && (
        <section className="device-lids">
          <div><span>设备 LID</span><b>{node.lids.length}</b></div>
          <p>{node.lids.map((lid) => <span className="address lid" key={lid}>{lid}</span>)}</p>
        </section>
      )}
      {node.serverInfo && (
        <section className="server-address-card">
          <div className="server-address-heading">
            <div><span>GPU 服务器地址</span>{node.serverInfo.manualOverride && <b>人工修订</b>}</div>
            {!editing && <button type="button" onClick={() => setEditing(true)}><Pencil size={13} />修改地址</button>}
          </div>
          {editing ? (
            <div className="server-address-editor">
              <label><span>带内地址</span><input aria-label="带内地址" value={inBandIp} onChange={(event) => setInBandIp(event.target.value)} placeholder="未配置" inputMode="decimal" /></label>
              <label><span>带外地址</span><input aria-label="带外地址" value={outOfBandIp} onChange={(event) => setOutOfBandIp(event.target.value)} placeholder="未配置" inputMode="decimal" /></label>
              <div>
                <button type="button" className="save-address" disabled={savingAddress} onClick={() => void save()}><Save size={13} />{savingAddress ? "保存中" : "保存"}</button>
                <button type="button" disabled={savingAddress} onClick={() => setEditing(false)}>取消</button>
                {node.serverInfo.manualOverride && <button type="button" disabled={savingAddress} onClick={() => void reset()}><RotateCcw size={13} />恢复清单值</button>}
              </div>
            </div>
          ) : (
            <dl className="server-address-values">
              <div><dt>带内</dt><dd>{node.serverInfo.inBandIp || "配置未提供"}</dd></div>
              <div><dt>带外</dt><dd>{node.serverInfo.outOfBandIp || "配置未提供"}</dd></div>
            </dl>
          )}
        </section>
      )}

      <nav className="inspector-tabs" aria-label="设备详情分类">
        <button type="button" className={deviceTab === "physical" ? "active" : ""} onClick={() => switchDeviceTab("physical")}>物理口</button>
        <button type="button" className={deviceTab === "aggregate" ? "active" : ""} onClick={() => switchDeviceTab("aggregate")}>聚合口</button>
        <button type="button" className={deviceTab === "forwarding" ? "active" : ""} onClick={() => switchDeviceTab("forwarding")}>转发表</button>
      </nav>

      {deviceTab === "physical" && <>
        <div className="interface-title"><span>物理接口</span><div><button type="button" className={onlyIp ? "active" : ""} aria-pressed={onlyIp} onClick={() => setOnlyIp((current) => !current)}>仅查看 IP</button><b>{visiblePhysical.length}/{physicalInterfaces.length}</b></div></div>
        <div className="interface-list">
          {visiblePhysical.length === 0 && visibleLogical.length === 0 ? (
            <div className="empty-interfaces"><CircleAlert size={16} />{onlyIp ? "没有配置 IP 的接口" : "配置中未提供物理接口"}</div>
          ) : <>
            {visiblePhysical.map((item) => (
              <button type="button" className={`interface-row${selectedInterface === item.name ? " active" : ""}`} key={item.name} onClick={() => highlightInterfaces(item.name, [item.name])}>
                <span className="interface-name"><strong>{item.name}</strong>{item.peers.length > 0 && <small>连接 {item.peers[0].device}</small>}</span>
                <span className="address-list">{item.addresses.length === 0 ? <span className="no-address">配置未提供 IP</span> : item.addresses.map((address) => <span className={address.type === "vrr" ? "address vrr" : "address"} key={`${address.type}-${address.cidr}`}>{address.type === "vrr" ? "VRR " : ""}{address.cidr}</span>)}</span>
                {item.description && <span className="interface-description" title={item.description}>{item.description}</span>}
              </button>
            ))}
            {visibleLogical.length > 0 && <div className="interface-subheading">其他逻辑接口</div>}
            {visibleLogical.map((item) => (
              <button type="button" className={`interface-row${selectedInterface === item.name ? " active" : ""}`} key={item.name} onClick={() => highlightInterfaces(item.name, [item.name])}>
                <span className="interface-name"><strong>{item.name}</strong><small>逻辑接口</small></span>
                <span className="address-list">{item.addresses.length === 0 ? <span className="no-address">配置未提供 IP</span> : item.addresses.map((address) => <span className={address.type === "vrr" ? "address vrr" : "address"} key={`${address.type}-${address.cidr}`}>{address.type === "vrr" ? "VRR " : ""}{address.cidr}</span>)}</span>
              </button>
            ))}
          </>}
        </div>
        <p className="inspector-hint">点击接口可在拓扑中高亮对应物理链路。</p>
      </>}

      {deviceTab === "aggregate" && <div className="interface-list aggregate-list">
        {forwardingLoading ? <div className="empty-interfaces">正在读取聚合接口…</div> : aggregateInterfaces.length === 0 ? <div className="empty-interfaces"><CircleAlert size={16} />当前快照没有聚合接口</div> : aggregateInterfaces.map((item) => (
          <button type="button" className={`aggregate-row${selectedInterface === item.name ? " active" : ""}`} key={item.name} onClick={() => highlightInterfaces(item.name, item.members.map((member) => member.memberInterface))}>
            <span><strong>{item.name}</strong><small>{item.attributes?.status === "down" ? "DOWN" : "UP"} · {item.attributes?.forwardingMode ?? "未声明模式"}</small></span>
            <b>{item.members.length} 个成员</b>
            <span className="aggregate-members">{item.members.length === 0 ? "未提供成员口" : item.members.map((member) => `${member.memberInterface}${member.status === "down" ? "(down)" : ""}`).join("、")}</span>
          </button>
        ))}
        {forwardingError && <div className="forwarding-table-error">{forwardingError}</div>}
      </div>}

      {deviceTab === "forwarding" && <div className="forwarding-browser">
        <label className="forwarding-table-search"><Search size={13} /><input value={forwardingQuery} onChange={(event) => setForwardingQuery(event.target.value)} placeholder="检索 IP、MAC、接口、VRF、VNI" aria-label="检索转发表" />{forwardingQuery && <button type="button" onClick={() => setForwardingQuery("")} aria-label="清空转发表检索"><X size={12} /></button>}</label>
        <nav className="forwarding-table-tabs" aria-label="转发表类型">
          {([['route', '路由', routes.length], ['arp', 'ARP', arpEntries.length], ['mac', 'MAC', macEntries.length], ['vxlan', 'VXLAN', vxlanEntries.length]] as const).map(([id, label, count]) => <button type="button" className={forwardingTab === id ? "active" : ""} key={id} onClick={() => setForwardingTab(id)}>{label}<b>{count}</b></button>)}
        </nav>
        <div className="forwarding-table-list">
          {forwardingLoading ? <div className="empty-interfaces">正在读取转发表…</div> : forwardingError ? <div className="forwarding-table-error">{forwardingError}</div> : tableRows.length === 0 ? <div className="empty-interfaces"><CircleAlert size={16} />{forwardingQuery ? "没有匹配的表项" : "当前设备没有此类表项"}</div> : forwardingTab === "route" ? routes.map((item, index) => <div className="forwarding-table-row" key={`${item.row}-${index}`}><strong>{item.destinationCidr}</strong><span>VRF {item.vrf} · {item.action}</span><small>{item.nextHop ? `下一跳 ${item.nextHop}` : "无下一跳"}{item.outputInterface ? ` · 出口 ${item.outputInterface}` : ""}{item.ecmpGroup ? ` · ECMP ${item.ecmpGroup}` : ""}{item.vni ? ` · VNI ${item.vni}` : ""}</small></div>) : forwardingTab === "arp" ? arpEntries.map((item, index) => <div className="forwarding-table-row" key={`${item.row}-${index}`}><strong>{item.ip}</strong><span>{item.mac}</span><small>VRF {item.vrf} · {item.interfaceName} · {item.status}</small></div>) : forwardingTab === "mac" ? macEntries.map((item, index) => <div className="forwarding-table-row" key={`${item.row}-${index}`}><strong>{item.mac}</strong><span>VLAN {item.vlan} · {item.action}</span><small>{item.outputInterface ? `出口 ${item.outputInterface}` : item.remoteVtep ? `远端 VTEP ${item.remoteVtep}` : "无出口"}{item.vni ? ` · VNI ${item.vni}` : ""}</small></div>) : vxlanEntries.map((item, index) => <div className="forwarding-table-row" key={`${item.row}-${index}`}><strong>VNI {item.vni} · {item.mode.toUpperCase()}</strong><span>{item.localVtep} · UDP {item.udpDestinationPort}</span><small>{item.vlan ? `VLAN ${item.vlan} · ` : ""}{item.tenantVrf ? `租户 VRF ${item.tenantVrf} · ` : ""}Underlay {item.underlayVrf} · {item.status}</small></div>)}
        </div>
      </div>}
    </aside>
  );
}
