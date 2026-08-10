/**
 * BulkCreateRadarSourcesDto 单元测试
 *
 * bulk 导入的 shape / SSRF / 上限拦截全靠 DTO 层（service 只做 identifier 形状 +
 * preflight），所以这里锁定 nested 校验链路真实工作：
 *   - 1..20 条边界
 *   - item 复用 CreateRadarSourceDto → type=X、authorityWeight 越界必须被拒
 *
 * 放在 services/source/__tests__ 而非 api/dto/__tests__：本次改动的授权文件范围
 * 只覆盖该目录。
 */

import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { BulkCreateRadarSourcesDto } from "../../../../api/dto";

function makeSource(i: number) {
  return { type: "RSS", identifier: `https://acct${i}.example/rss` };
}

async function validateBulk(payload: unknown) {
  return validate(plainToInstance(BulkCreateRadarSourcesDto, payload));
}

describe("BulkCreateRadarSourcesDto", () => {
  it("accepts 20 条（上限边界）", async () => {
    const errs = await validateBulk({
      sources: Array.from({ length: 20 }, (_, i) => makeSource(i)),
    });
    expect(errs).toEqual([]);
  });

  it("rejects 21 条 (ArrayMaxSize)", async () => {
    const errs = await validateBulk({
      sources: Array.from({ length: 21 }, (_, i) => makeSource(i)),
    });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]?.constraints).toHaveProperty("arrayMaxSize");
  });

  it("rejects 空数组 (ArrayMinSize)", async () => {
    const errs = await validateBulk({ sources: [] });
    expect(errs[0]?.constraints).toHaveProperty("arrayMinSize");
  });

  it("rejects type=X（写侧禁 X，与 accept 路径一致）", async () => {
    const errs = await validateBulk({
      sources: [{ type: "X", identifier: "@elonmusk" }],
    });
    const typeErr = errs
      .find((e) => e.property === "sources")
      ?.children?.[0]?.children?.find((c) => c.property === "type");
    expect(typeErr?.constraints).toHaveProperty("isEnum");
  });

  it("rejects authorityWeight 越界 (6)", async () => {
    const errs = await validateBulk({
      sources: [{ ...makeSource(0), authorityWeight: 6 }],
    });
    const weightErr = errs
      .find((e) => e.property === "sources")
      ?.children?.[0]?.children?.find((c) => c.property === "authorityWeight");
    expect(weightErr?.constraints).toHaveProperty("max");
  });

  it("accepts 完整可选字段组合（label / config / enabled / authorityWeight）", async () => {
    const errs = await validateBulk({
      sources: [
        {
          ...makeSource(0),
          label: "Stratechery",
          config: { fetchTranscript: true },
          enabled: false,
          authorityWeight: 5,
        },
      ],
    });
    expect(errs).toEqual([]);
  });

  it.each(["GITHUB", "HUGGING_FACE"])(
    "accepts native typed source %s",
    async (type) => {
      const errs = await validateBulk({
        sources: [
          { type, identifier: type === "GITHUB" ? "trending" : "papers" },
        ],
      });
      expect(errs).toEqual([]);
    },
  );
});
