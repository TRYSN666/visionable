import {
  AlertTriangle,
  Box,
  ChevronDown,
  Filter,
  FileUp,
  Focus,
  FolderPlus,
  Layers3,
  Minus,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Save,
  Search,
  Server,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEVICE_ROLES, POD_NAMES, type DeviceRole, type LinkPlane, type TopologyNode, type TopologyProject, type TopologySnapshot } from "../shared/topology";
import { buildGraphModel, type GraphEdgeData } from "./graphModel";
import { ForwardingSimulator } from "./ForwardingSimulator";
import { Inspector } from "./Inspector";
import { emptyGraphSelection, shouldShowHoveredNode, updateGraphBoxSelection, updateGraphSelection } from "./selectionModel";
import { TopologyCanvas, type SimulationCanvasState, type SimulationDevice, type TopologyCanvasHandle } from "./TopologyCanvas";

const roleLabels: Record<DeviceRole, string> = {
  CSW: "核心 CSW",
  SSW: "骨干 SSW",
  ASW: "接入 ASW",
  HSS: "服务 HSS",
  MGMT: "管理 MGMT",
  LSW: "业务 LSW",
  SOOB: "带外核心 SOOB",
  OOB: "带外 OOB",
  IBCR: "IB 核心 IBCR",
  IBSP: "IB 骨干 IBSP",
  IBLF: "IB 接入 IBLF",
  SERVER: "服务器",
  ENDPOINT: "外部终端",
  UNKNOWN: "未识别",
};

const podLabels: Record<string, string> = {
  POD1: "POD 1",
  POD2: "POD 2",
  POD3: "POD 3",
  SHARED: "共享设备",
  UNKNOWN: "未识别",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function toggleSet<T>(source: Set<T>, value: T): Set<T> {
  const next = new Set(source);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<TopologySnapshot>();
  const [projects, setProjects] = useState<TopologyProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [activeTopologyId, setActiveTopologyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(true);
  const [query, setQuery] = useState("");
  const [pods, setPods] = useState(new Set<string>(POD_NAMES));
  const [roles, setRoles] = useState(new Set<string>(DEVICE_ROLES));
  const [planes, setPlanes] = useState(new Set<LinkPlane>(["production", "management"]));
  const [expandedClusters, setExpandedClusters] = useState(new Set<string>());
  const [visibleGpuPods, setVisibleGpuPods] = useState(new Set<string>());
  const [hoveredId, setHoveredId] = useState<string>();
  const [pinnedId, setPinnedId] = useState<string>();
  const [selection, setSelection] = useState(emptyGraphSelection);
  const [gpuSourceIds, setGpuSourceIds] = useState(new Set<string>());
  const [selectedEdge, setSelectedEdge] = useState<GraphEdgeData>();
  const [inspectorHighlightedLinkIds, setInspectorHighlightedLinkIds] = useState<ReadonlySet<string>>(new Set());
  const [savingAddress, setSavingAddress] = useState(false);
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [savingLayout, setSavingLayout] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [importTargetProjectId, setImportTargetProjectId] = useState<string>();
  const [importFile, setImportFile] = useState<File>();
  const [importName, setImportName] = useState("");
  const [importing, setImporting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [forwardingOpen, setForwardingOpen] = useState(false);
  const [simulationCanvas, setSimulationCanvas] = useState<SimulationCanvasState>();
  const [simulationNodeIds, setSimulationNodeIds] = useState<ReadonlySet<string>>(new Set());
  const [simulationDevice, setSimulationDevice] = useState<SimulationDevice>();
  const [simulationDeviceTargetId, setSimulationDeviceTargetId] = useState<string>();
  const [simulationSourceIp, setSimulationSourceIp] = useState("");
  const [simulationSourceError, setSimulationSourceError] = useState<string>();
  const clearHoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const canvasRef = useRef<TopologyCanvasHandle>(null);
  const layoutChangeVersion = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadTopology = useCallback(async (projectId: string, topologyId: string, refresh = false) => {
    setRefreshing(true);
    setError(undefined);
    try {
      const base = `/api/projects/${encodeURIComponent(projectId)}/topologies/${encodeURIComponent(topologyId)}`;
      const response = await fetch(refresh ? `${base}/refresh` : base, {
        method: refresh ? "POST" : "GET",
        headers: { Accept: "application/json" },
      });
      const data = await response.json() as TopologySnapshot | { error?: string };
      if (!response.ok || !("nodes" in data)) throw new Error("error" in data ? data.error : "无法读取拓扑数据");
      setSnapshot(data);
      setExpandedClusters(new Set());
      setVisibleGpuPods(new Set());
      setSelection(emptyGraphSelection());
      setGpuSourceIds(new Set());
      setSelectedEdge(undefined);
      setLayoutDirty(false);
      setSimulationCanvas(undefined);
      setSimulationNodeIds(new Set());
      setSimulationDevice(undefined);
      setSimulationDeviceTargetId(undefined);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取拓扑数据");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const initialize = async () => {
      try {
        const response = await fetch("/api/projects", { headers: { Accept: "application/json" } });
        const data = await response.json() as TopologyProject[] | { error?: string };
        if (!response.ok || !Array.isArray(data)) throw new Error(!Array.isArray(data) ? data.error : "无法读取项目");
        setProjects(data);
        const project = data.find((item) => item.id === "metta") ?? data.find((item) => item.topologies.length > 0);
        const topology = project?.topologies.find((item) => item.id === "metta-roce") ?? project?.topologies[0];
        if (!project || !topology) throw new Error("项目中尚无拓扑，请先新增拓扑");
        setActiveProjectId(project.id);
        setActiveTopologyId(topology.id);
        await loadTopology(project.id, topology.id);
      } catch (initialError) {
        setError(initialError instanceof Error ? initialError.message : "无法读取项目");
        setRefreshing(false);
      }
    };
    void initialize();
  }, [loadTopology]);

  const visibleSimulationNodeIds = useMemo(() => new Set([
    ...simulationNodeIds,
    ...(simulationDevice ? [simulationDevice.deviceId] : []),
  ]), [simulationDevice, simulationNodeIds]);
  const model = useMemo(
    () => snapshot ? buildGraphModel(snapshot, { query, pods, roles, planes, expandedClusters, selectedNodeIds: selection.nodeIds, gpuSourceNodeIds: gpuSourceIds, visibleGpuPods, simulationNodeIds: visibleSimulationNodeIds }) : undefined,
    [expandedClusters, gpuSourceIds, planes, pods, query, roles, selection.nodeIds, snapshot, visibleGpuPods, visibleSimulationNodeIds],
  );
  const graphNodeById = useMemo(() => new Map(model?.nodes.map((node) => [node.id, node]) ?? []), [model]);
  const nodeById = useMemo(() => new Map(snapshot?.nodes.map((node) => [node.id, node]) ?? []), [snapshot]);
  const inspectedNode = graphNodeById.get(pinnedId ?? hoveredId ?? "");
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeTopology = activeProject?.topologies.find((topology) => topology.id === activeTopologyId);

  const switchTopology = useCallback(async (projectId: string, topologyId: string) => {
    setActiveProjectId(projectId);
    setActiveTopologyId(topologyId);
    await loadTopology(projectId, topologyId);
  }, [loadTopology]);

  const reloadActiveTopologyData = useCallback(async () => {
    if (!activeProjectId || !activeTopologyId) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(activeProjectId)}/topologies/${encodeURIComponent(activeTopologyId)}`, { headers: { Accept: "application/json" } });
    const data = await response.json() as TopologySnapshot | { error?: string };
    if (!response.ok || !("nodes" in data)) throw new Error("error" in data ? data.error : "无法重新读取拓扑数据");
    setSnapshot(data);
  }, [activeProjectId, activeTopologyId]);

  const openImport = useCallback((projectId: string) => {
    setImportTargetProjectId(projectId);
    setImportFile(undefined);
    setImportName("");
    setDragActive(false);
    setImportOpen(true);
  }, []);

  const selectImportFile = useCallback((file: File) => {
    if (!/\.(?:csv|xlsx)$/i.test(file.name)) {
      setError("连线表必须是 CSV 或 XLSX 文件");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setError("连线表不能超过 12 MiB");
      return;
    }
    setError(undefined);
    setImportFile(file);
    setImportName((current) => current || file.name.replace(/\.(?:csv|xlsx)$/i, ""));
  }, []);

  const createProject = useCallback(async () => {
    const name = window.prompt("请输入项目名称");
    if (!name?.trim()) return;
    setError(undefined);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const project = await response.json() as TopologyProject | { error?: string };
      if (!response.ok || !("topologies" in project)) throw new Error("error" in project ? project.error : "无法创建项目");
      setProjects((current) => [...current, project]);
      openImport(project.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "无法创建项目");
    }
  }, [openImport]);

  const renameProject = useCallback(async (project: TopologyProject) => {
    const name = window.prompt("修改项目名称", project.name);
    if (!name?.trim() || name.trim() === project.name) return;
    setError(undefined);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const updated = await response.json() as TopologyProject | { error?: string };
      if (!response.ok || !("topologies" in updated)) throw new Error("error" in updated ? updated.error : "无法修改项目名称");
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : "无法修改项目名称");
    }
  }, []);

  const renameTopology = useCallback(async () => {
    if (!activeProject || !activeTopology) return;
    const name = window.prompt("修改拓扑名称", activeTopology.name);
    if (!name?.trim() || name.trim() === activeTopology.name) return;
    setError(undefined);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(activeProject.id)}/topologies/${encodeURIComponent(activeTopology.id)}`, {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const updated = await response.json() as TopologyProject | { error?: string };
      if (!response.ok || !("topologies" in updated)) throw new Error("error" in updated ? updated.error : "无法修改拓扑名称");
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : "无法修改拓扑名称");
    }
  }, [activeProject, activeTopology]);

  const importTopology = useCallback(async () => {
    if (!importFile || !importTargetProjectId || !importName.trim()) return;
    setImporting(true);
    setError(undefined);
    try {
      const isXlsx = importFile.name.toLowerCase().endsWith(".xlsx");
      const csvText = isXlsx ? undefined : await importFile.text();
      const xlsxBase64 = isXlsx ? await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("无法读取 XLSX 文件"));
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
        reader.readAsDataURL(importFile);
      }) : undefined;
      const response = await fetch(`/api/projects/${encodeURIComponent(importTargetProjectId)}/topologies/import`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ name: importName.trim(), fileName: importFile.name, csvText, xlsxBase64 }),
      });
      const data = await response.json() as { projects?: TopologyProject[]; topologyId?: string; snapshot?: TopologySnapshot; error?: string };
      if (!response.ok || !data.projects || !data.topologyId || !data.snapshot) throw new Error(data.error ?? "无法导入连线表");
      setProjects(data.projects);
      setActiveProjectId(importTargetProjectId);
      setActiveTopologyId(data.topologyId);
      setSnapshot(data.snapshot);
      setExpandedClusters(new Set());
      setVisibleGpuPods(new Set());
      setSelection(emptyGraphSelection());
      setGpuSourceIds(new Set());
      setPinnedId(undefined);
      setHoveredId(undefined);
      setSelectedEdge(undefined);
      setLayoutDirty(false);
      setImportOpen(false);
      setImportFile(undefined);
      setImportName("");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "无法导入连线表");
    } finally {
      setImporting(false);
    }
  }, [importFile, importName, importTargetProjectId]);

  const handleNodeHover = useCallback((id?: string) => {
    if (clearHoverTimer.current) clearTimeout(clearHoverTimer.current);
    if (id && shouldShowHoveredNode(selection, id)) setHoveredId(id);
    else if (id) setHoveredId(undefined);
    else clearHoverTimer.current = setTimeout(() => setHoveredId(undefined), 160);
  }, [selection]);
  const keepInspector = useCallback(() => {
    if (clearHoverTimer.current) clearTimeout(clearHoverTimer.current);
  }, []);
  const leaveInspector = useCallback(() => {
    if (!pinnedId) clearHoverTimer.current = setTimeout(() => setHoveredId(undefined), 160);
  }, [pinnedId]);
  const handleNodeSelect = useCallback((id?: string, additive = false) => {
    setInspectorHighlightedLinkIds(new Set());
    if (!id) {
      setSelection(emptyGraphSelection());
      setGpuSourceIds(new Set());
      setPinnedId(undefined);
      setSelectedEdge(undefined);
      return;
    }
    const selectedNode = nodeById.get(id);
    const nextSelection = updateGraphSelection(selection, { kind: "node", id }, additive);
    setSelection(nextSelection);
    if (selectedNode?.kind === "configured") {
      setGpuSourceIds(new Set([...nextSelection.nodeIds].filter((nodeId) => nodeById.get(nodeId)?.kind === "configured")));
    }
    setPinnedId(nextSelection.nodeIds.size === 1 && nextSelection.nodeIds.has(id) ? id : undefined);
    if (nextSelection.nodeIds.size > 1) setHoveredId(undefined);
    setSelectedEdge(undefined);
  }, [nodeById, selection]);
  const handleEdgeSelect = useCallback((edge?: GraphEdgeData, additive = false) => {
    setInspectorHighlightedLinkIds(new Set());
    if (!edge) {
      setSelection(emptyGraphSelection());
      setGpuSourceIds(new Set());
      setSelectedEdge(undefined);
      setPinnedId(undefined);
      return;
    }
    const nextSelection = updateGraphSelection(selection, { kind: "edge", id: edge.id }, additive);
    setSelection(nextSelection);
    setSelectedEdge(nextSelection.edgeIds.has(edge.id) ? edge : undefined);
    if (!additive) setPinnedId(undefined);
  }, [selection]);
  const handleNodesBoxSelect = useCallback((ids: string[], additive = false) => {
    setInspectorHighlightedLinkIds(new Set());
    const nextSelection = updateGraphBoxSelection(selection, ids, additive);
    setSelection(nextSelection);
    setGpuSourceIds(new Set([...nextSelection.nodeIds].filter((nodeId) => nodeById.get(nodeId)?.kind === "configured")));
    setPinnedId(undefined);
    setHoveredId(undefined);
    setSelectedEdge(undefined);
  }, [nodeById, selection]);
  const handleClusterToggle = useCallback((id: string) => {
    setInspectorHighlightedLinkIds(new Set());
    setExpandedClusters((current) => toggleSet(current, id));
    setPinnedId(undefined);
    setHoveredId(undefined);
    setSelectedEdge(undefined);
  }, []);

  const saveServerAddresses = useCallback(async (hostname: string, values: { inBandIp: string; outOfBandIp: string }) => {
    setSavingAddress(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/server-addresses/${encodeURIComponent(hostname)}`, {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await response.json() as TopologySnapshot | { error?: string };
      if (!response.ok || !("nodes" in data)) throw new Error("error" in data ? data.error : "无法保存服务器地址");
      setSnapshot(data);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "无法保存服务器地址");
      throw saveError;
    } finally {
      setSavingAddress(false);
    }
  }, []);

  const resetServerAddresses = useCallback(async (hostname: string) => {
    setSavingAddress(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/server-addresses/${encodeURIComponent(hostname)}`, { method: "DELETE", headers: { Accept: "application/json" } });
      const data = await response.json() as TopologySnapshot | { error?: string };
      if (!response.ok || !("nodes" in data)) throw new Error("error" in data ? data.error : "无法恢复服务器清单地址");
      setSnapshot(data);
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "无法恢复服务器清单地址");
      throw resetError;
    } finally {
      setSavingAddress(false);
    }
  }, []);

  const markLayoutDirty = useCallback(() => {
    layoutChangeVersion.current += 1;
    setLayoutDirty(true);
  }, []);

  const saveLayout = useCallback(async () => {
    const positions = canvasRef.current?.getPositions();
    if (!positions || Object.keys(positions).length === 0) return;
    const savedVersion = layoutChangeVersion.current;
    setSavingLayout(true);
    setError(undefined);
    try {
      if (!activeProjectId || !activeTopologyId) throw new Error("当前拓扑不存在");
      const response = await fetch(`/api/projects/${encodeURIComponent(activeProjectId)}/topologies/${encodeURIComponent(activeTopologyId)}/layout`, {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ positions }),
      });
      const data = await response.json() as TopologySnapshot | { error?: string };
      if (!response.ok || !("nodes" in data)) throw new Error("error" in data ? data.error : "无法保存拓扑布局");
      setSnapshot(data);
      if (layoutChangeVersion.current === savedVersion) setLayoutDirty(false);
    } catch (layoutError) {
      setError(layoutError instanceof Error ? layoutError.message : "无法保存拓扑布局");
    } finally {
      setSavingLayout(false);
    }
  }, [activeProjectId, activeTopologyId]);

  const handleSimulationChange = useCallback((simulation: SimulationCanvasState | undefined, nodeIds: ReadonlySet<string>) => {
    setSimulationCanvas(simulation);
    setSimulationNodeIds(nodeIds);
  }, []);

  const openSimulationDevice = useCallback((deviceId: string) => {
    setSimulationDeviceTargetId(deviceId);
    setSimulationSourceIp(simulationDevice?.deviceId === deviceId ? simulationDevice.sourceIp : "");
    setSimulationSourceError(undefined);
  }, [simulationDevice]);

  const saveSimulationDevice = useCallback(() => {
    const parts = simulationSourceIp.split(".");
    const valid = parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
    if (!simulationDeviceTargetId || !valid) {
      setSimulationSourceError("请输入有效的源 IPv4 地址");
      return;
    }
    setSimulationDevice((current) => ({
      deviceId: simulationDeviceTargetId,
      sourceIp: simulationSourceIp,
      position: current?.deviceId === simulationDeviceTargetId ? current.position : undefined,
    }));
    setSimulationDeviceTargetId(undefined);
    setSimulationSourceError(undefined);
  }, [simulationDeviceTargetId, simulationSourceIp]);

  const exitSimulation = useCallback(() => {
    setForwardingOpen(false);
    setSimulationCanvas(undefined);
    setSimulationNodeIds(new Set());
    setSimulationDevice(undefined);
    setSimulationDeviceTargetId(undefined);
  }, []);

  if (!snapshot && refreshing) {
    return (
      <main className="loading-screen">
        <div className="loading-mark"><Network size={32} /><span /></div>
        <p>正在解析设备配置并构建拓扑…</p>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="error-screen">
        <AlertTriangle size={30} />
        <h1>拓扑数据暂不可用</h1>
        <p>{error ?? "配置目录中没有可用数据"}</p>
        <button type="button" onClick={() => activeProjectId && activeTopologyId && void loadTopology(activeProjectId, activeTopologyId, true)}><RefreshCw size={15} />重新读取</button>
      </main>
    );
  }

  const stats = snapshot.stats;
  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-symbol"><Network size={22} /></div>
          <div><p>{activeProject?.name ?? "VISIONABLE"} / NETWORK FABRIC</p><h1>{activeTopology?.name ?? "网络拓扑中心"}</h1></div>
        </div>
        <div className="header-actions">
          <div className="source-state"><span /><div><b>{snapshot.sourceType === "ports-csv" ? "连线表已加载" : "配置数据已加载"}</b><small>{activeProject?.name} · 更新于 {formatTime(snapshot.refreshedAt)}</small></div></div>
          <button className="primary-button" type="button" disabled={refreshing} onClick={() => activeProjectId && activeTopologyId && void loadTopology(activeProjectId, activeTopologyId, true)}>
            <RefreshCw size={15} className={refreshing ? "spin" : ""} />{refreshing ? "正在刷新" : snapshot.sourceType === "ports-csv" ? "重新载入" : "刷新配置"}
          </button>
          <button className={forwardingOpen ? "simulation-button active" : "simulation-button"} type="button" aria-pressed={forwardingOpen} onClick={() => {
            if (forwardingOpen) return;
            setSelection(emptyGraphSelection());
            setGpuSourceIds(new Set());
            setPinnedId(undefined);
            setHoveredId(undefined);
            setSelectedEdge(undefined);
            setForwardingOpen(true);
          }}><Route size={15} />{forwardingOpen ? "仿真模式已开启" : "流量仿真"}</button>
        </div>
      </header>

      <section className="summary-strip" aria-label="拓扑摘要">
        <div><Server size={15} /><span><b>{stats.configuredDevices}</b> {snapshot.sourceType === "ports-csv" ? "网络设备" : "配置设备"}</span></div>
        <div><Box size={15} /><span><b>{stats.externalDevices}</b> {snapshot.sourceType === "ports-csv" ? "服务器" : "外部终端"}</span></div>
        <div><Layers3 size={15} /><span><b>{stats.physicalLinks.toLocaleString("zh-CN")}</b> 物理链路</span></div>
        <div><SlidersHorizontal size={15} /><span><b>{stats.usedInterfaces.toLocaleString("zh-CN")}</b> 使用中接口</span></div>
        <span className="summary-spacer" />
        <span className="static-badge">{snapshot.sourceType === "ports-csv" ? "静态连线表视图" : "静态配置视图"} · 非实时状态</span>
      </section>

      {error && <div className="inline-error"><AlertTriangle size={15} />刷新失败，继续显示上一份有效拓扑：{error}<button type="button" onClick={() => setError(undefined)}><X size={14} /></button></div>}
      {snapshot.warnings.length > 0 && (
        <details className="warning-bar">
          <summary><AlertTriangle size={14} />{snapshot.warnings.length} 条解析提示<ChevronDown size={14} /></summary>
          <ul>{snapshot.warnings.slice(0, 30).map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.sourceFile && `${warning.sourceFile}：`}{warning.message}</li>)}</ul>
        </details>
      )}

      <section className={`main-workspace${filtersOpen ? "" : " sidebar-closed"}${forwardingOpen ? " simulation-open" : ""}`}>
        <aside className="sidebar">
          <section className="catalog-panel" aria-label="项目与拓扑">
            <div className="catalog-heading"><span><Network size={14} />项目拓扑</span><button type="button" onClick={() => void createProject()} title="新增项目" aria-label="新增项目"><FolderPlus size={14} /></button></div>
            <div className="project-selector">
              <select
                value={activeProjectId}
                onChange={(event) => {
                  const project = projects.find((item) => item.id === event.target.value);
                  if (!project) return;
                  if (project.topologies[0]) void switchTopology(project.id, project.topologies[0].id);
                  else openImport(project.id);
                }}
                aria-label="选择项目"
              >
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              {activeProject && <button type="button" onClick={() => void renameProject(activeProject)} title="修改项目名称" aria-label="修改项目名称"><Pencil size={13} /></button>}
            </div>
            <div className="topology-list">
              {activeProject?.topologies.map((topology) => (
                <button
                  type="button"
                  className={topology.id === activeTopologyId ? "topology-item active" : "topology-item"}
                  key={topology.id}
                  onClick={() => void switchTopology(activeProject.id, topology.id)}
                >
                  <span><b>{topology.name}</b><small>{topology.nodeCount.toLocaleString("zh-CN")} 节点 · {topology.linkCount.toLocaleString("zh-CN")} 链路</small></span>
                  {topology.id === activeTopologyId && <Pencil size={11} onClick={(event) => { event.stopPropagation(); void renameTopology(); }} aria-label="修改拓扑名称" />}
                </button>
              ))}
            </div>
            {activeProject && <button className="add-topology-button" type="button" onClick={() => openImport(activeProject.id)}><FileUp size={14} />新增拓扑</button>}
          </section>

          <div className="sidebar-heading"><span><Filter size={14} />视图筛选</span><button type="button" onClick={() => setFiltersOpen(false)} aria-label="收起筛选栏"><X size={14} /></button></div>
          <label className="search-field"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="设备、接口、IP 或 LID" />{query && <button type="button" onClick={() => setQuery("")} aria-label="清空搜索"><X size={13} /></button>}</label>

          <fieldset>
            <legend>网络区域</legend>
            <div className="filter-grid">
              {POD_NAMES.map((pod) => <button type="button" className={pods.has(pod) ? "filter-chip active" : "filter-chip"} key={pod} onClick={() => setPods((current) => toggleSet(current, pod))}>{podLabels[pod]}</button>)}
            </div>
            <div className="gpu-filter-grid" aria-label="GPU 展示范围">
              {(["POD1", "POD2", "POD3"] as const).map((pod) => <button type="button" className={visibleGpuPods.has(pod) ? "filter-chip gpu-filter-chip active" : "filter-chip gpu-filter-chip"} aria-pressed={visibleGpuPods.has(pod)} key={`${pod}-GPU`} onClick={() => setVisibleGpuPods((current) => toggleSet(current, pod))}>{pod}-{snapshot.sourceType === "ports-csv" ? "服务器" : "GPU"}</button>)}
            </div>
          </fieldset>
          <fieldset>
            <legend>设备角色</legend>
            <div className="role-list">
              {DEVICE_ROLES.filter((role) => role !== "UNKNOWN").map((role) => (
                <label key={role}><input type="checkbox" checked={roles.has(role)} onChange={() => setRoles((current) => toggleSet(current, role))} /><span className={`role-dot role-${role.toLowerCase()}`} />{roleLabels[role]}</label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>链路平面</legend>
            <label className="switch-row"><span className="line-swatch production" />生产网络<input type="checkbox" checked={planes.has("production")} onChange={() => setPlanes((current) => toggleSet(current, "production"))} /></label>
            <label className="switch-row"><span className="line-swatch management" />管理网络<input type="checkbox" checked={planes.has("management")} onChange={() => setPlanes((current) => toggleSet(current, "management"))} /></label>
          </fieldset>
          <button className="reset-filters" type="button" onClick={() => { setQuery(""); setPods(new Set(POD_NAMES)); setRoles(new Set(DEVICE_ROLES)); setPlanes(new Set(["production", "management"])); setVisibleGpuPods(new Set()); }}>重置全部筛选</button>
        </aside>

        <section className="canvas-panel">
          <div className="canvas-toolbar">
            {!filtersOpen && <button type="button" onClick={() => setFiltersOpen(true)}><Filter size={14} />筛选</button>}
            <div className="visible-count"><span>{model?.nodes.length ?? 0}</span> 个可见节点 · <span>{model?.edges.length ?? 0}</span> 组链路</div>
            <div className="canvas-actions">
              <button type="button" className={layoutDirty ? "layout-save dirty" : "layout-save"} disabled={!layoutDirty || savingLayout} onClick={() => void saveLayout()}><Save size={15} />{savingLayout ? "保存中" : layoutDirty ? "保存拓扑 · 未保存" : "保存拓扑"}</button>
              {selection.nodeIds.size + selection.edgeIds.size > 0 && <button type="button" onClick={() => { setSelection(emptyGraphSelection()); setGpuSourceIds(new Set()); setPinnedId(undefined); setSelectedEdge(undefined); }}>清除选择 ({selection.nodeIds.size + selection.edgeIds.size})</button>}
              <button type="button" onClick={() => canvasRef.current?.zoomOut()} aria-label="缩小"><Minus size={15} /></button>
              <button type="button" onClick={() => canvasRef.current?.zoomIn()} aria-label="放大"><Plus size={15} /></button>
              <button type="button" onClick={() => canvasRef.current?.fit()}><Focus size={15} />适配画布</button>
            </div>
          </div>
          {model && model.nodes.length > 0 ? (
            <TopologyCanvas
              ref={canvasRef}
              model={model}
              snapshotRevision={`${activeTopologyId ?? "topology"}:${snapshot.revision}`}
              selectedIds={selection.nodeIds}
              selectedEdgeIds={selection.edgeIds}
              highlightedTopologyLinkIds={inspectorHighlightedLinkIds}
              onLayoutDirty={markLayoutDirty}
              onNodeHover={handleNodeHover}
              onNodeSelect={handleNodeSelect}
              onNodesBoxSelect={handleNodesBoxSelect}
              onClusterToggle={handleClusterToggle}
              onEdgeSelect={handleEdgeSelect}
              simulation={simulationCanvas}
              simulationMode={forwardingOpen}
              simulationDevice={simulationDevice}
              onSimulationDeviceRequest={openSimulationDevice}
              onSimulationDevicePositionChange={(position) => setSimulationDevice((current) => current ? { ...current, position } : current)}
            />
          ) : (
            <div className="empty-graph"><Search size={24} /><h2>没有匹配的设备</h2><p>调整搜索条件或重新启用筛选项。</p></div>
          )}
          <div className="canvas-legend"><span><i className="legend-device" />{snapshot.sourceType === "ports-csv" ? "网络设备" : "配置设备"}</span><span><i className="legend-endpoint" />{snapshot.sourceType === "ports-csv" ? "服务器" : "外部终端"}</span><span><i className="legend-cluster" />折叠终端簇</span></div>
          <div className="canvas-help">{forwardingOpen ? "仿真模式 · 右键任意设备创建模拟设备" : "普通点击单选 · Ctrl 点击追加 · Alt 拖拽框选后可批量移动"}</div>
          {!forwardingOpen && <Inspector
            graphNode={inspectedNode}
            edge={selectedEdge}
            nodeById={nodeById as Map<string, TopologyNode>}
            projectId={activeProjectId}
            topologyId={activeTopologyId}
            topologyLinks={snapshot.links}
            onHighlightLinks={setInspectorHighlightedLinkIds}
            pinned={Boolean(pinnedId)}
            savingAddress={savingAddress}
            onSaveServerAddresses={saveServerAddresses}
            onResetServerAddresses={resetServerAddresses}
            onClose={() => { setSelection(emptyGraphSelection()); setGpuSourceIds(new Set()); setPinnedId(undefined); setHoveredId(undefined); setSelectedEdge(undefined); setInspectorHighlightedLinkIds(new Set()); }}
            onMouseEnter={keepInspector}
            onMouseLeave={leaveInspector}
          />}
          {forwardingOpen && activeProjectId && activeTopologyId && (
            <ForwardingSimulator
              key={`${activeProjectId}:${activeTopologyId}:${simulationDevice?.deviceId ?? ""}:${simulationDevice?.sourceIp ?? ""}`}
              projectId={activeProjectId}
              topologyId={activeTopologyId}
              topology={snapshot}
              simulationDevice={simulationDevice}
              onClose={exitSimulation}
              onSimulationChange={handleSimulationChange}
              onTopologyChanged={reloadActiveTopologyData}
            />
          )}
        </section>
      </section>
      {importOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !importing) setImportOpen(false); }}>
          <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
            <div className="import-heading">
              <div><p>新增拓扑</p><h2 id="import-title">导入端口连线表</h2></div>
              <button type="button" disabled={importing} onClick={() => setImportOpen(false)} aria-label="关闭导入窗口"><X size={17} /></button>
            </div>
            <p className="import-description">导入到 <b>{projects.find((project) => project.id === importTargetProjectId)?.name}</b>。支持本端/对端设备、端口、可选 IP 和 LID 字段；同设备记录按逻辑接口处理。</p>
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => { const file = event.target.files?.[0]; if (file) selectImportFile(file); }}
            />
            <button
              type="button"
              className={dragActive ? "csv-dropzone active" : "csv-dropzone"}
              onClick={() => fileInputRef.current?.click()}
              onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
              onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
              onDragLeave={(event) => { event.preventDefault(); setDragActive(false); }}
              onDrop={(event) => { event.preventDefault(); setDragActive(false); const file = event.dataTransfer.files[0]; if (file) selectImportFile(file); }}
            >
              <FileUp size={26} />
              {importFile ? <><b>{importFile.name}</b><span>{(importFile.size / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} KiB · 点击可更换</span></> : <><b>拖拽 CSV 或 XLSX 到这里</b><span>或点击选择文件，最大 12 MiB</span></>}
            </button>
            <label className="import-name"><span>拓扑名称</span><input value={importName} onChange={(event) => setImportName(event.target.value)} maxLength={80} placeholder="例如：Metta IB网络" /></label>
            <div className="import-actions">
              <button type="button" disabled={importing} onClick={() => setImportOpen(false)}>取消</button>
              <button className="primary-button" type="button" disabled={importing || !importFile || !importName.trim()} onClick={() => void importTopology()}>{importing ? <RefreshCw className="spin" size={14} /> : <FileUp size={14} />}{importing ? "正在解析" : "导入并打开"}</button>
            </div>
          </section>
        </div>
      )}
      {simulationDeviceTargetId && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSimulationDeviceTargetId(undefined); }}>
          <form className="simulation-device-modal" role="dialog" aria-modal="true" aria-labelledby="simulation-device-title" onSubmit={(event) => { event.preventDefault(); saveSimulationDevice(); }}>
            <div className="import-heading">
              <div><p>模拟设备</p><h2 id="simulation-device-title">创建流量源</h2></div>
              <button type="button" onClick={() => setSimulationDeviceTargetId(undefined)} aria-label="关闭创建模拟设备窗口"><X size={17} /></button>
            </div>
            <p className="import-description">挂载到 <b>{nodeById.get(simulationDeviceTargetId)?.hostname}</b>。源 IP 是本次模拟流量进入该设备时使用的地址。</p>
            <label className="simulation-source-field"><span>源 IPv4</span><input value={simulationSourceIp} onChange={(event) => { setSimulationSourceIp(event.target.value.trim()); setSimulationSourceError(undefined); }} placeholder="例如：10.0.0.1" /></label>
            {simulationSourceError && <div className="forwarding-error"><AlertTriangle size={14} />{simulationSourceError}</div>}
            <div className="import-actions"><button type="button" onClick={() => setSimulationDeviceTargetId(undefined)}>取消</button><button className="primary-button" type="submit">创建模拟设备</button></div>
          </form>
        </div>
      )}
    </main>
  );
}
