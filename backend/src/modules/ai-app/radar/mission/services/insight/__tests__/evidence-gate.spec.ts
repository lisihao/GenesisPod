/**
 * 证据门禁（highlights + signals 同一套规则）
 *
 * 复核意见（2026-08-13）指出两个漏洞，本文件逐条锁住：
 *  1. highlight 之前「只删假 id、不删结论」——留下一条有论点无出处的高亮，
 *     比不显示更糟：它看起来仍然像有依据的结论。person 主题下必须整条删。
 *  2. 丢弃计数用「进来多少 - 出去多少」算，把 slice(0,5) 的截断也算成
 *     「缺证据」。计数必须只统计门禁删掉的那一份。
 */
import {
  normalizeHighlights,
  normalizeSignals,
} from "../radar-insight-synthesis.service";

const ALLOWED = new Set(["A", "B"]);

describe("证据门禁 — highlights", () => {
  it("person 主题：没有有效 itemIds 的高亮整条删除，不是只删 id", () => {
    const result = normalizeHighlights(
      [
        { title: "有证据", itemIds: ["A", "假id"], type: "trend" },
        { title: "全是假 id", itemIds: ["ghost"], type: "trend" },
        { title: "压根没给 itemIds", type: "anomaly" },
      ],
      ALLOWED,
      true,
    );
    expect(result.kept).toEqual([
      { title: "有证据", itemIds: ["A"], type: "trend" },
    ]);
    expect(result.droppedForEvidence).toBe(2);
  });

  it("非 person 主题：只剔除假 id，结论保留（沿用既有行为）", () => {
    const result = normalizeHighlights(
      [{ title: "无证据", itemIds: ["ghost"], type: "trend" }],
      ALLOWED,
      false,
    );
    expect(result.kept).toEqual([
      { title: "无证据", itemIds: [], type: "trend" },
    ]);
    expect(result.droppedForEvidence).toBe(0);
  });

  it("非法 type 仍回落 trend", () => {
    const result = normalizeHighlights(
      [{ title: "x", itemIds: ["A"], type: "WILD" }],
      ALLOWED,
      true,
    );
    expect(result.kept[0].type).toBe("trend");
  });
});

describe("证据门禁 — signals", () => {
  it("person 主题：无证据 signal 整条删除并计数", () => {
    const result = normalizeSignals(
      [
        { kind: "有证据", magnitude: 8, evidence: "e", itemIds: ["B"] },
        { kind: "无证据", magnitude: 5, evidence: "推断" },
      ],
      ALLOWED,
      true,
    );
    expect(result.kept).toEqual([
      { kind: "有证据", magnitude: 8, evidence: "e", itemIds: ["B"] },
    ]);
    expect(result.droppedForEvidence).toBe(1);
  });

  it("非 person 主题不做删除", () => {
    const result = normalizeSignals(
      [{ kind: "无证据", magnitude: 5, evidence: "推断" }],
      ALLOWED,
      false,
    );
    expect(result.kept).toHaveLength(1);
    expect(result.droppedForEvidence).toBe(0);
  });
});

describe("丢弃计数只统计证据门禁", () => {
  it("超过 5 条被截断的部分不计入 droppedForEvidence", () => {
    // 8 条全部带有效证据：slice(0,5) 会砍掉 3 条，但那不是「缺证据」
    const many = Array.from({ length: 8 }, (_, i) => ({
      kind: `k${i}`,
      magnitude: 5,
      evidence: "e",
      itemIds: ["A"],
    }));
    const result = normalizeSignals(many, ALLOWED, true);
    expect(result.kept).toHaveLength(5);
    expect(result.droppedForEvidence).toBe(0);
  });

  it("截断与缺证据同时发生时，只报缺证据那部分", () => {
    // 前 5 条里 2 条缺证据；第 6-8 条被截断
    const mixed = [
      { kind: "k0", magnitude: 5, evidence: "e", itemIds: ["A"] },
      { kind: "k1", magnitude: 5, evidence: "e" },
      { kind: "k2", magnitude: 5, evidence: "e", itemIds: ["ghost"] },
      { kind: "k3", magnitude: 5, evidence: "e", itemIds: ["B"] },
      { kind: "k4", magnitude: 5, evidence: "e", itemIds: ["A"] },
      { kind: "k5", magnitude: 5, evidence: "e", itemIds: ["A"] },
      { kind: "k6", magnitude: 5, evidence: "e", itemIds: ["A"] },
    ];
    const result = normalizeSignals(mixed, ALLOWED, true);
    expect(result.kept).toHaveLength(3);
    expect(result.droppedForEvidence).toBe(2);
  });

  it("非对象条目不计入缺证据", () => {
    const result = normalizeSignals(
      [
        null,
        "junk",
        { kind: "ok", magnitude: 5, evidence: "e", itemIds: ["A"] },
      ],
      ALLOWED,
      true,
    );
    expect(result.kept).toHaveLength(1);
    expect(result.droppedForEvidence).toBe(0);
  });
});
