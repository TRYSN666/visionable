import { describe, expect, it } from "vitest";
import { alignedNodePosition, packetPosition, selectionRectanglesIntersect, viewportUpdateMode } from "../src/TopologyCanvas";

describe("topology canvas viewport", () => {
  it("fits only on the first model and preserves the viewport afterwards", () => {
    expect(viewportUpdateMode(false)).toBe("fit");
    expect(viewportUpdateMode(true)).toBe("preserve");
  });

  it("detects nodes intersecting an Alt drag selection rectangle", () => {
    const selection = { left: 10, top: 10, right: 80, bottom: 80 };
    expect(selectionRectanglesIntersect(selection, { left: 40, top: 40, right: 100, bottom: 100 })).toBe(true);
    expect(selectionRectanglesIntersect(selection, { left: 81, top: 10, right: 120, bottom: 50 })).toBe(false);
  });

  it("aligns selected nodes to the right-clicked reference axis", () => {
    const current = { x: 10, y: 20 };
    const reference = { x: 80, y: 90 };
    expect(alignedNodePosition(current, reference, "horizontal")).toEqual({ x: 10, y: 90 });
    expect(alignedNodePosition(current, reference, "vertical")).toEqual({ x: 80, y: 20 });
  });

  it("recomputes packet positions from the latest dragged endpoints", () => {
    expect(packetPosition({ x: 0, y: 0 }, { x: 100, y: 40 }, 0.25)).toEqual({ x: 25, y: 10 });
    expect(packetPosition({ x: 80, y: 20 }, { x: 200, y: 100 }, 0.25)).toEqual({ x: 110, y: 40 });
  });
});
