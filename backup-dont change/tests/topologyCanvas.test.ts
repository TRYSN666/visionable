import { describe, expect, it } from "vitest";
import { alignedNodePosition, selectionRectanglesIntersect, viewportUpdateMode } from "../src/TopologyCanvas";

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
});
