import cytoscape, { type Core, type EventObject } from "cytoscape";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { ForwardingTraceResult } from "../shared/forwarding";
import { edgeIsHighlighted, type GraphEdgeData, type GraphModel, type GraphNodeData } from "./graphModel";

export interface TopologyCanvasHandle {
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  getPositions: () => Record<string, { x: number; y: number }>;
}

interface TopologyCanvasProps {
  model: GraphModel;
  snapshotRevision: string;
  selectedIds: ReadonlySet<string>;
  selectedEdgeIds: ReadonlySet<string>;
  onLayoutDirty: () => void;
  onNodeHover: (id?: string) => void;
  onNodeSelect: (id?: string, additive?: boolean) => void;
  onNodesBoxSelect: (ids: string[], additive?: boolean) => void;
  onClusterToggle: (id: string) => void;
  onEdgeSelect: (edge?: GraphEdgeData, additive?: boolean) => void;
  simulation?: SimulationCanvasState;
  simulationMode?: boolean;
  simulationDevice?: SimulationDevice;
  onSimulationDeviceRequest?: (deviceId: string) => void;
}

export interface SimulationDevice {
  deviceId: string;
  sourceIp: string;
}

export interface SimulationCanvasState {
  trace: ForwardingTraceResult;
  visibleTransitionIds: ReadonlySet<string>;
  activeTransitionIds: ReadonlySet<string>;
  packets: Array<{ id: string; transitionId: string; progress: number }>;
}

const roleColors: Record<string, string> = {
  CSW: "#0f766e",
  SSW: "#25658a",
  ASW: "#b06632",
  HSS: "#7c5aa6",
  MGMT: "#607d8b",
  LSW: "#357a68",
  SOOB: "#6f7e82",
  OOB: "#596c72",
  IBCR: "#0f766e",
  IBSP: "#25658a",
  IBLF: "#b06632",
  SERVER: "#87989d",
  ENDPOINT: "#87989d",
  UNKNOWN: "#9c7b4b",
};

const stylesheet = [
  {
    selector: "node",
    style: {
      "background-color": roleColors.UNKNOWN,
      "border-color": "#ffffff",
      "border-width": 2,
      color: "#1a282e",
      label: "data(label)",
      "font-family": "Arial, Microsoft YaHei, sans-serif",
      "font-size": 10,
      "font-weight": 600,
      "text-valign": "bottom",
      "text-margin-y": 8,
      "text-wrap": "wrap",
      "text-overflow-wrap": "anywhere",
      "text-max-width": 220,
      width: 34,
      height: 34,
      "overlay-opacity": 0,
    },
  },
  ...Object.entries(roleColors).map(([role, color]) => ({
    selector: `node[role = "${role}"]`,
    style: { "background-color": color },
  })),
  {
    selector: 'node[kind = "configured"]',
    style: { shape: "round-rectangle", width: 52, height: 32 },
  },
  {
    selector: 'node[kind = "external"]',
    style: { shape: "ellipse", width: 26, height: 26, "font-size": 9 },
  },
  {
    selector: 'node[kind = "cluster"]',
    style: {
      shape: "hexagon",
      width: 48,
      height: 42,
      "background-color": "#f6faf9",
      "border-color": "#6d858a",
      "border-width": 2,
      "border-style": "dashed",
      "font-size": 9,
    },
  },
  {
    selector: "node:selected",
    style: {
      "border-color": "#ffb54a",
      "border-width": 4,
    },
  },
  {
    selector: "edge",
    style: {
      width: "mapData(count, 1, 48, 1, 6)",
      "line-color": "#75a69f",
      "curve-style": "bezier",
      opacity: 0.55,
      label: "data(label)",
      "font-size": 8,
      color: "#607178",
      "text-background-color": "#ffffff",
      "text-background-opacity": 0.88,
      "text-background-padding": 2,
      "min-zoomed-font-size": 8,
      "overlay-opacity": 0,
    },
  },
  {
    selector: 'edge[plane = "management"]',
    style: { "line-color": "#8b999e", "line-style": "dashed", opacity: 0.42 },
  },
  {
    selector: "edge:selected",
    style: { "line-color": "#e09232", opacity: 0.95, "z-index": 10 },
  },
  {
    selector: "edge.selected-path",
    style: { "line-color": "#ff7a00", width: 5, opacity: 1, "z-index": 20 },
  },
  {
    selector: "edge.simulation-edge",
    style: {
      "line-color": "#ef233c",
      "target-arrow-color": "#ef233c",
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.85,
      width: 4,
      opacity: 0.9,
      "curve-style": "bezier",
      "z-index": 80,
      label: "",
    },
  },
  {
    selector: "edge.simulation-edge-active",
    style: { "line-style": "dashed", "line-dash-pattern": [9, 6], width: 5, opacity: 1 },
  },
  {
    selector: 'node[kind = "simulation-packet"]',
    style: {
      shape: "round-diamond",
      width: 18,
      height: 14,
      "background-color": "#ef233c",
      "border-color": "#ffffff",
      "border-width": 2,
      label: "",
      "z-index": 100,
    },
  },
  {
    selector: 'node[kind = "simulation-device"]',
    style: {
      shape: "round-rectangle",
      width: 74,
      height: 27,
      "background-color": "#fff1f3",
      "border-color": "#ef233c",
      "border-width": 2,
      color: "#a9192d",
      label: "data(label)",
      "font-family": "ui-monospace, Consolas, monospace",
      "font-size": 8,
      "text-valign": "center",
      "text-margin-y": 0,
      "z-index": 90,
    },
  },
  {
    selector: "edge.simulation-device-edge",
    style: { "line-color": "#ef8795", "line-style": "dashed", width: 2, opacity: 0.9, label: "", "z-index": 70 },
  },
] as unknown as cytoscape.StylesheetJson;

export function viewportUpdateMode(hasInitializedViewport: boolean): "fit" | "preserve" {
  return hasInitializedViewport ? "preserve" : "fit";
}

export interface SelectionRectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function selectionRectanglesIntersect(first: SelectionRectangle, second: SelectionRectangle): boolean {
  return first.left <= second.right && first.right >= second.left && first.top <= second.bottom && first.bottom >= second.top;
}

export function alignedNodePosition(
  current: { x: number; y: number },
  reference: { x: number; y: number },
  direction: "horizontal" | "vertical",
): { x: number; y: number } {
  return direction === "horizontal"
    ? { x: current.x, y: reference.y }
    : { x: reference.x, y: current.y };
}

export function packetPosition(start: { x: number; y: number }, end: { x: number; y: number }, progress: number): { x: number; y: number } {
  return { x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress };
}

export const TopologyCanvas = forwardRef<TopologyCanvasHandle, TopologyCanvasProps>(function TopologyCanvas(
  { model, snapshotRevision, selectedIds, selectedEdgeIds, onLayoutDirty, onNodeHover, onNodeSelect, onNodesBoxSelect, onClusterToggle, onEdgeSelect, simulation, simulationMode = false, simulationDevice, onSimulationDeviceRequest },
  ref,
) {
  const shellRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectionBoxRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | undefined>(undefined);
  const keyboardIndex = useRef(-1);
  const workingPositions = useRef(new Map<string, { x: number; y: number }>());
  const activeRevision = useRef<string | undefined>(undefined);
  const hasInitializedViewport = useRef(false);
  const boxGesture = useRef<{ pointerId: number; startX: number; startY: number } | undefined>(undefined);
  const [alignmentMenu, setAlignmentMenu] = useState<{ nodeId: string; label: string; x: number; y: number }>();
  const [simulationMenu, setSimulationMenu] = useState<{ nodeId: string; label: string; x: number; y: number }>();
  const handlers = useRef({ onLayoutDirty, onNodeHover, onNodeSelect, onNodesBoxSelect, onClusterToggle, onEdgeSelect, onSimulationDeviceRequest });
  const simulationRef = useRef(simulation);
  const simulationDeviceRef = useRef(simulationDevice);
  const simulationModeRef = useRef(simulationMode);

  const refreshSimulationDevicePosition = () => {
    const cy = cyRef.current;
    const current = simulationDeviceRef.current;
    if (!cy || !current) return;
    const target = cy.getElementById(current.deviceId);
    const device = cy.getElementById("simulation-device");
    if (target.empty() || device.empty()) return;
    const position = target.position();
    device.position({ x: position.x + 72, y: position.y - 48 });
  };

  const refreshPacketPositions = () => {
    const cy = cyRef.current;
    const current = simulationRef.current;
    if (!cy || !current) return;
    const transitionById = new Map(current.trace.transitions.map((transition) => [transition.id, transition]));
    cy.batch(() => {
      for (const packet of current.packets) {
        const transition = transitionById.get(packet.transitionId);
        if (!transition) continue;
        const source = cy.getElementById(transition.fromDeviceId);
        const target = cy.getElementById(transition.toDeviceId);
        const token = cy.getElementById(`simulation-packet:${packet.id}`);
        if (source.empty() || target.empty() || token.empty()) continue;
        const start = source.position();
        const end = target.position();
        token.position(packetPosition(start, end, packet.progress));
      }
    });
  };

  useEffect(() => {
    handlers.current = { onLayoutDirty, onNodeHover, onNodeSelect, onNodesBoxSelect, onClusterToggle, onEdgeSelect, onSimulationDeviceRequest };
  }, [onClusterToggle, onEdgeSelect, onLayoutDirty, onNodeHover, onNodeSelect, onNodesBoxSelect, onSimulationDeviceRequest]);

  useEffect(() => {
    simulationModeRef.current = simulationMode;
    if (!simulationMode) setSimulationMenu(undefined);
  }, [simulationMode]);

  useImperativeHandle(ref, () => ({
    fit: () => cyRef.current?.fit(undefined, 64),
    zoomIn: () => {
      const cy = cyRef.current;
      if (cy) cy.zoom({ level: Math.min(cy.maxZoom(), cy.zoom() * 1.25), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    },
    zoomOut: () => {
      const cy = cyRef.current;
      if (cy) cy.zoom({ level: Math.max(cy.minZoom(), cy.zoom() / 1.25), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    },
    getPositions: () => {
      const positions = new Map(workingPositions.current);
      const realIds = new Set(model.nodes.map((node) => node.id));
      cyRef.current?.nodes().forEach((node) => {
        if (realIds.has(node.id())) positions.set(node.id(), node.position());
      });
      return Object.fromEntries([...positions].filter(([id]) => realIds.has(id)));
    },
  }), [model.nodes]);

  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: stylesheet,
      boxSelectionEnabled: false,
      selectionType: "additive",
    });
    cyRef.current = cy;
    hasInitializedViewport.current = false;
    let resizeFrame = 0;
    const resizeCanvas = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        cy.resize();
        if (cy.elements().length > 0) cy.fit(undefined, 64);
        refreshPacketPositions();
        refreshSimulationDevicePosition();
      });
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resizeCanvas);
    resizeObserver?.observe(containerRef.current);
    window.addEventListener("resize", resizeCanvas);

    const nodeOver = (event: EventObject) => {
      if ((event.target.data() as { kind?: string }).kind !== "simulation-device") handlers.current.onNodeHover(event.target.id());
    };
    const nodeOut = (event: EventObject) => {
      if ((event.target.data() as { kind?: string }).kind !== "simulation-device") handlers.current.onNodeHover(undefined);
    };
    const nodeTap = (event: EventObject) => {
      setAlignmentMenu(undefined);
      setSimulationMenu(undefined);
      const data = event.target.data() as { kind: string; id: string };
      if (data.kind === "simulation-packet" || data.kind === "simulation-device") return;
      if (data.kind === "cluster") handlers.current.onClusterToggle(data.id);
      else {
        const original = event.originalEvent as MouseEvent | undefined;
        handlers.current.onNodeSelect(data.id, Boolean(original?.ctrlKey));
      }
    };
    const edgeTap = (event: EventObject) => {
      setAlignmentMenu(undefined);
      setSimulationMenu(undefined);
      const original = event.originalEvent as MouseEvent | undefined;
      handlers.current.onEdgeSelect(event.target.data() as GraphEdgeData, Boolean(original?.ctrlKey));
    };
    const nodeDragFree = (event: EventObject) => {
      if ((event.target.data() as { kind?: string }).kind === "simulation-packet") return;
      const movedNodes = event.target.selected() ? cy.nodes(":selected") : cy.collection(event.target);
      movedNodes.forEach((node) => { workingPositions.current.set(node.id(), node.position()); });
      handlers.current.onLayoutDirty();
      refreshSimulationDevicePosition();
    };
    const backgroundTap = (event: EventObject) => {
      if (event.target === cy) {
        setAlignmentMenu(undefined);
        setSimulationMenu(undefined);
        handlers.current.onNodeSelect(undefined);
        handlers.current.onEdgeSelect(undefined);
      }
    };
    const nodeContextTap = (event: EventObject) => {
      const data = event.target.data() as GraphNodeData;
      if (simulationModeRef.current && !["cluster", "simulation-packet", "simulation-device"].includes(data.kind)) {
        (event.originalEvent as MouseEvent | undefined)?.preventDefault();
        const renderedPosition = event.renderedPosition;
        const shell = shellRef.current;
        if (!shell || !renderedPosition) return;
        setAlignmentMenu(undefined);
        setSimulationMenu({
          nodeId: data.id,
          label: data.hostname,
          x: Math.max(8, Math.min(renderedPosition.x + 8, shell.clientWidth - 184)),
          y: Math.max(8, Math.min(renderedPosition.y + 8, shell.clientHeight - 82)),
        });
        return;
      }
      const selectedNodes = cy.nodes(":selected");
      if (!event.target.selected() || selectedNodes.length < 2) {
        setAlignmentMenu(undefined);
        return;
      }
      (event.originalEvent as MouseEvent | undefined)?.preventDefault();
      const renderedPosition = event.renderedPosition;
      const shell = shellRef.current;
      if (!shell || !renderedPosition) return;
      setAlignmentMenu({
        nodeId: data.id,
        label: data.hostname,
        x: Math.max(8, Math.min(renderedPosition.x + 8, shell.clientWidth - 184)),
        y: Math.max(8, Math.min(renderedPosition.y + 8, shell.clientHeight - 112)),
      });
    };
    const closeContextMenus = () => { setAlignmentMenu(undefined); setSimulationMenu(undefined); };
    cy.on("mouseover", "node", nodeOver);
    cy.on("mouseout", "node", nodeOut);
    cy.on("tap", "node", nodeTap);
    cy.on("tap", "edge", edgeTap);
    cy.on("cxttap", "node", nodeContextTap);
    cy.on("dragfree", "node", nodeDragFree);
    cy.on("tap", backgroundTap);
    cy.on("pan zoom", closeContextMenus);
    cy.on("position drag", 'node[kind != "simulation-packet"][kind != "simulation-device"]', () => { refreshPacketPositions(); refreshSimulationDevicePosition(); });

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resizeCanvas);
      cancelAnimationFrame(resizeFrame);
      cy.destroy();
      cyRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const previousViewport = { zoom: cy.zoom(), pan: cy.pan() };
    if (activeRevision.current !== snapshotRevision) {
      workingPositions.current.clear();
      activeRevision.current = snapshotRevision;
    } else {
      cy.nodes().forEach((node) => {
        if ((node.data() as { kind?: string }).kind !== "simulation-packet") workingPositions.current.set(node.id(), node.position());
      });
    }
    cy.elements().remove();
    cy.add([
      ...model.nodes.map((node) => ({ data: node, position: workingPositions.current.get(node.id) ?? model.positions.get(node.id) })),
      ...model.edges.map((edge) => ({ data: edge })),
    ]);
    cy.layout({ name: "preset", fit: false, padding: 70, animate: false }).run();
    if (viewportUpdateMode(hasInitializedViewport.current) === "fit") {
      cy.fit(undefined, 64);
      hasInitializedViewport.current = true;
    } else {
      cy.zoom(previousViewport.zoom);
      cy.pan(previousViewport.pan);
    }
    keyboardIndex.current = -1;
  }, [model, snapshotRevision]);

  useEffect(() => {
    simulationDeviceRef.current = simulationDevice;
    const cy = cyRef.current;
    if (!cy) return;
    cy.getElementById("simulation-device-edge").remove();
    cy.getElementById("simulation-device").remove();
    if (!simulationDevice || cy.getElementById(simulationDevice.deviceId).empty()) return;
    cy.add([
      { group: "nodes", data: { id: "simulation-device", kind: "simulation-device", label: `模拟设备\n${simulationDevice.sourceIp}` }, grabbable: false, selectable: false },
      { group: "edges", data: { id: "simulation-device-edge", source: "simulation-device", target: simulationDevice.deviceId }, classes: "simulation-device-edge", selectable: false },
    ]);
    refreshSimulationDevicePosition();
  }, [model, simulationDevice]);

  useEffect(() => {
    simulationRef.current = simulation;
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements(".simulation-edge").remove();
    cy.nodes('[kind = "simulation-packet"]').remove();
    if (!simulation) return;
    const visible = simulation.trace.transitions.filter((transition) => simulation.visibleTransitionIds.has(transition.id));
    cy.add(visible.flatMap((transition) => {
      if (cy.getElementById(transition.fromDeviceId).empty() || cy.getElementById(transition.toDeviceId).empty()) return [];
      return [{
        group: "edges" as const,
        data: { id: `simulation-edge:${transition.id}`, source: transition.fromDeviceId, target: transition.toDeviceId, transitionId: transition.id },
        classes: simulation.activeTransitionIds.has(transition.id) ? "simulation-edge simulation-edge-active" : "simulation-edge",
        selectable: false,
      }];
    }));
    cy.add(simulation.packets.flatMap((packet) => {
      const transition = simulation.trace.transitions.find((item) => item.id === packet.transitionId);
      if (!transition || cy.getElementById(transition.fromDeviceId).empty()) return [];
      return [{
        group: "nodes" as const,
        data: { id: `simulation-packet:${packet.id}`, kind: "simulation-packet", label: "" },
        position: cy.getElementById(transition.fromDeviceId).position(),
        grabbable: false,
        selectable: false,
      }];
    }));
    refreshPacketPositions();
  }, [model, simulation]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !simulation || simulation.activeTransitionIds.size === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let offset = 0;
    const animate = () => {
      offset = (offset + 0.8) % 30;
      cy.edges(".simulation-edge-active").style("line-dash-offset", -offset);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [simulation]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().unselect();
    for (const id of selectedIds) cy.getElementById(id).select();
    cy.edges().unselect();
    for (const id of selectedEdgeIds) cy.getElementById(id).select();
    cy.edges().removeClass("selected-path");
    for (const edge of model.edges) {
      if (edgeIsHighlighted(edge, selectedIds, selectedEdgeIds)) {
        cy.getElementById(edge.id).addClass("selected-path");
      }
    }
  }, [model, selectedEdgeIds, selectedIds]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const cy = cyRef.current;
    if (!cy || model.nodes.length === 0) return;
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      keyboardIndex.current = (keyboardIndex.current + direction + model.nodes.length) % model.nodes.length;
      const node = model.nodes[keyboardIndex.current];
      cy.nodes().unselect();
      const element = cy.getElementById(node.id);
      element.select();
      onNodeHover(node.id);
    } else if (event.key === "Enter" && keyboardIndex.current >= 0) {
      const node = model.nodes[keyboardIndex.current];
      if (node.kind === "cluster") onClusterToggle(node.id);
      else onNodeSelect(node.id);
    } else if (event.key === "Escape") {
      cy.nodes().unselect();
      onNodeHover(undefined);
      onNodeSelect(undefined);
      onEdgeSelect(undefined);
    }
  };

  const relativePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)),
      y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)),
    };
  };

  const updateSelectionBox = (startX: number, startY: number, endX: number, endY: number) => {
    const element = selectionBoxRef.current;
    if (!element) return;
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    element.style.display = "block";
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.width = `${Math.abs(endX - startX)}px`;
    element.style.height = `${Math.abs(endY - startY)}px`;
  };

  const finishBoxGesture = (event: ReactPointerEvent<HTMLDivElement>, selectNodes: boolean) => {
    const gesture = boxGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const point = relativePointer(event);
    if (selectNodes) {
      const selectionRectangle: SelectionRectangle = {
        left: Math.min(gesture.startX, point.x),
        top: Math.min(gesture.startY, point.y),
        right: Math.max(gesture.startX, point.x),
        bottom: Math.max(gesture.startY, point.y),
      };
      const ids = cyRef.current?.nodes().filter((node) => {
        if (["cluster", "simulation-packet", "simulation-device"].includes((node.data() as GraphNodeData).kind)) return false;
        const bounds = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
        return selectionRectanglesIntersect(selectionRectangle, { left: bounds.x1, top: bounds.y1, right: bounds.x2, bottom: bounds.y2 });
      }).map((node) => node.id()) ?? [];
      handlers.current.onNodesBoxSelect(ids, event.ctrlKey);
    }
    boxGesture.current = undefined;
    if (selectionBoxRef.current) selectionBoxRef.current.style.display = "none";
    cyRef.current?.userPanningEnabled(true);
    event.currentTarget.classList.remove("box-selecting");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handlePointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.altKey || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const point = relativePointer(event);
    boxGesture.current = { pointerId: event.pointerId, startX: point.x, startY: point.y };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("box-selecting");
    event.currentTarget.focus({ preventScroll: true });
    cyRef.current?.userPanningEnabled(false);
    updateSelectionBox(point.x, point.y, point.x, point.y);
  };

  const handlePointerMoveCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = boxGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const point = relativePointer(event);
    updateSelectionBox(gesture.startX, gesture.startY, point.x, point.y);
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const cy = cyRef.current;
    const shell = shellRef.current;
    if (!simulationMode || !cy || !shell) return;
    const bounds = shell.getBoundingClientRect();
    const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const target = cy.nodes().filter((node) => {
      const kind = (node.data() as GraphNodeData).kind;
      if (["cluster", "simulation-packet", "simulation-device"].includes(kind)) return false;
      const box = node.renderedBoundingBox({ includeLabels: false, includeOverlays: true });
      return point.x >= box.x1 - 5 && point.x <= box.x2 + 5 && point.y >= box.y1 - 5 && point.y <= box.y2 + 5;
    }).first();
    if (target.empty()) return;
    const data = target.data() as GraphNodeData;
    setAlignmentMenu(undefined);
    setSimulationMenu({
      nodeId: data.id,
      label: data.hostname,
      x: Math.max(8, Math.min(point.x + 8, shell.clientWidth - 184)),
      y: Math.max(8, Math.min(point.y + 8, shell.clientHeight - 82)),
    });
  };

  const alignSelectedNodes = (direction: "horizontal" | "vertical") => {
    const cy = cyRef.current;
    const referenceNode = alignmentMenu ? cy?.getElementById(alignmentMenu.nodeId) : undefined;
    if (!cy || !referenceNode || referenceNode.empty()) return;
    const referencePosition = referenceNode.position();
    cy.batch(() => {
      cy.nodes(":selected").forEach((node) => {
        const position = alignedNodePosition(node.position(), referencePosition, direction);
        node.position(position);
        workingPositions.current.set(node.id(), position);
      });
    });
    handlers.current.onLayoutDirty();
    setAlignmentMenu(undefined);
  };

  return (
    <div
      ref={shellRef}
      className="topology-canvas-shell"
      role="application"
      tabIndex={0}
      aria-label="网络拓扑画布。普通点击单选，按住 Ctrl 点击多选，按住 Alt 拖拽可框选并批量移动设备；使用方向键浏览节点，回车查看或展开，Escape 清除选择。"
      onKeyDown={handleKeyDown}
      onPointerDownCapture={handlePointerDownCapture}
      onPointerMoveCapture={handlePointerMoveCapture}
      onPointerUpCapture={(event) => finishBoxGesture(event, true)}
      onPointerCancel={(event) => finishBoxGesture(event, false)}
      onContextMenu={handleContextMenu}
    >
      <div ref={containerRef} className="topology-canvas" />
      <div ref={selectionBoxRef} className="topology-selection-box" aria-hidden="true" />
      {alignmentMenu && (
        <div className="alignment-menu" role="menu" style={{ left: alignmentMenu.x, top: alignmentMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <p title={alignmentMenu.label}>以 {alignmentMenu.label} 为基准</p>
          <button type="button" role="menuitem" onClick={() => alignSelectedNodes("horizontal")}><span className="align-icon horizontal" />横向对齐<small>统一 Y</small></button>
          <button type="button" role="menuitem" onClick={() => alignSelectedNodes("vertical")}><span className="align-icon vertical" />纵向对齐<small>统一 X</small></button>
        </div>
      )}
      {simulationMenu && (
        <div className="alignment-menu simulation-context-menu" role="menu" style={{ left: simulationMenu.x, top: simulationMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <p title={simulationMenu.label}>{simulationMenu.label}</p>
          <button type="button" role="menuitem" onClick={() => { handlers.current.onSimulationDeviceRequest?.(simulationMenu.nodeId); setSimulationMenu(undefined); }}><span className="simulation-source-icon" />创建模拟设备<small>填写源 IP</small></button>
        </div>
      )}
    </div>
  );
});
