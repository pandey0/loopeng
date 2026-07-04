import { describe, expect, it } from "vitest";
import { buildAgentRunTree, flattenAgentRunTree } from "./agent-run-tree";

interface Run {
  id: string;
  parentAgentRunId: string | null;
  label?: string;
}

const run = (id: string, parentAgentRunId: string | null = null): Run => ({ id, parentAgentRunId });

describe("buildAgentRunTree", () => {
  it("keeps a flat list flat", () => {
    const roots = buildAgentRunTree([run("a"), run("b")]);
    expect(roots.map((r) => r.run.id)).toEqual(["a", "b"]);
    expect(roots.every((r) => r.children.length === 0)).toBe(true);
  });

  it("nests sub-agent runs under their parent", () => {
    const roots = buildAgentRunTree([run("parent"), run("child-1", "parent"), run("child-2", "parent")]);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.children.map((c) => c.run.id)).toEqual(["child-1", "child-2"]);
  });

  it("supports multi-level delegation", () => {
    const roots = buildAgentRunTree([run("a"), run("b", "a"), run("c", "b")]);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.children[0]?.run.id).toBe("b");
    expect(roots[0]?.children[0]?.children[0]?.run.id).toBe("c");
  });

  it("treats a run with an unknown parent as a root instead of dropping it", () => {
    const roots = buildAgentRunTree([run("orphan", "not-in-list"), run("a")]);
    expect(roots.map((r) => r.run.id)).toEqual(["orphan", "a"]);
  });

  it("treats a self-referencing run as a root rather than recursing forever", () => {
    const roots = buildAgentRunTree([run("weird", "weird")]);
    expect(roots.map((r) => r.run.id)).toEqual(["weird"]);
    expect(roots[0]?.children).toHaveLength(0);
  });

  it("preserves input order among siblings at every level", () => {
    const roots = buildAgentRunTree([run("p2"), run("p1"), run("c-late", "p1"), run("c-early", "p1")]);
    expect(roots.map((r) => r.run.id)).toEqual(["p2", "p1"]);
    expect(roots[1]?.children.map((c) => c.run.id)).toEqual(["c-late", "c-early"]);
  });
});

describe("flattenAgentRunTree", () => {
  it("flattens depth-first with correct depths", () => {
    const roots = buildAgentRunTree([run("a"), run("b", "a"), run("c", "b"), run("d")]);
    const flat = flattenAgentRunTree(roots);
    expect(flat.map((f) => [f.run.id, f.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 0],
    ]);
  });
});
