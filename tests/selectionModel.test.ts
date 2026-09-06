import { describe, expect, it } from "vitest";
import { emptyGraphSelection, shouldShowHoveredNode, updateGraphBoxSelection, updateGraphSelection } from "../src/selectionModel";

describe("graph selection", () => {
  it("keeps only the current device or edge for an ordinary click", () => {
    const nodes = updateGraphSelection(emptyGraphSelection(), { kind: "node", id: "n1" });
    const replacedNode = updateGraphSelection(nodes, { kind: "node", id: "n2" });
    expect([...replacedNode.nodeIds]).toEqual(["n2"]);
    expect(replacedNode.edgeIds.size).toBe(0);

    const replacedByEdge = updateGraphSelection(replacedNode, { kind: "edge", id: "e1" });
    expect(replacedByEdge.nodeIds.size).toBe(0);
    expect([...replacedByEdge.edgeIds]).toEqual(["e1"]);
  });

  it("adds and removes mixed devices and edges only for Ctrl-style additive clicks", () => {
    let selection = updateGraphSelection(emptyGraphSelection(), { kind: "node", id: "n1" }, true);
    selection = updateGraphSelection(selection, { kind: "node", id: "n2" }, true);
    selection = updateGraphSelection(selection, { kind: "edge", id: "e1" }, true);
    expect([...selection.nodeIds]).toEqual(["n1", "n2"]);
    expect([...selection.edgeIds]).toEqual(["e1"]);

    selection = updateGraphSelection(selection, { kind: "node", id: "n1" }, true);
    expect([...selection.nodeIds]).toEqual(["n2"]);
    expect([...selection.edgeIds]).toEqual(["e1"]);
  });

  it("replaces selection for an Alt box and optionally merges with Ctrl+Alt", () => {
    const current = { nodeIds: new Set(["old"]), edgeIds: new Set(["edge-1"]) };
    const replaced = updateGraphBoxSelection(current, ["a", "b"]);
    expect([...replaced.nodeIds]).toEqual(["a", "b"]);
    expect(replaced.edgeIds.size).toBe(0);

    const merged = updateGraphBoxSelection(current, ["a", "b"], true);
    expect([...merged.nodeIds]).toEqual(["old", "a", "b"]);
    expect([...merged.edgeIds]).toEqual(["edge-1"]);
  });

  it("suppresses hover details only for devices in a batch selection", () => {
    const selection = { nodeIds: new Set(["a", "b"]), edgeIds: new Set<string>() };
    expect(shouldShowHoveredNode(selection, "a")).toBe(false);
    expect(shouldShowHoveredNode(selection, "other")).toBe(true);
    expect(shouldShowHoveredNode({ nodeIds: new Set(["a"]), edgeIds: new Set() }, "a")).toBe(true);
  });
});
