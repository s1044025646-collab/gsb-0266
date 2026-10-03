/**
 * 端到端演示：
 * 1) 菱形继承共享祖先去重；
 * 2) 交换父类顺序后方法提供者变化（产生新版本，旧版本仍可复算）；
 * 3) A(X,Y)、B(Y,X)、Z(A,B) 无一致线性化；
 * 4) “服务重启”（关闭后重开同一数据库）仍能读取同一版本并复算旧报告。
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "./store.js";
import { AnalysisService } from "./service.js";
import { ALGORITHM_VERSION } from "./c3.js";

const DEMO_DB = resolve("data", "demo", "c3.sqlite");

function hr(title: string): void {
  process.stdout.write(`\n==== ${title} ====\n`);
}

function main(): void {
  rmSync(resolve("data", "demo"), { recursive: true, force: true });

  hr("案例 1：菱形继承 D(B,C)，B/C 均继承 A，A 在 MRO 中只出现一次");
  let store = new Store(DEMO_DB);
  let svc = new AnalysisService(store);
  const v1 = svc.importDeclarations(
    [
      { name: "A", parents: [], methods: ["who"] },
      { name: "B", parents: ["A"], methods: [] },
      { name: "C", parents: ["A"], methods: [] },
      { name: "D", parents: ["B", "C"], methods: [] },
    ],
    "菱形",
  ).version;
  const dMro = svc.linearization(v1, "D", true);
  process.stdout.write(`D 的 MRO: ${dMro.mro?.join(" -> ")}\n`);

  hr("案例 2：D(B,C) 中 B.who 遮蔽 C.who；交换为 D(C,B) 后提供者变为 C（新版本）");
  svc.importDeclarations(
    [
      { name: "A", parents: [], methods: [] },
      { name: "B", parents: ["A"], methods: ["who"] },
      { name: "C", parents: ["A"], methods: ["who"] },
      { name: "D", parents: ["B", "C"], methods: [] },
    ],
    "B 在前",
  );
  const before = svc.lookup(svc.resolveVersion(undefined), "D", "who");
  process.stdout.write(`D(B,C): who 来自 ${before.lookup.provider}，被遮蔽 ${JSON.stringify(before.lookup.shadowed)}\n`);

  const vSwapped = svc.importDeclarations(
    [
      { name: "A", parents: [], methods: [] },
      { name: "B", parents: ["A"], methods: ["who"] },
      { name: "C", parents: ["A"], methods: ["who"] },
      { name: "D", parents: ["C", "B"], methods: [] },
    ],
    "C 在前（父类顺序交换）",
  ).version;
  const after = svc.lookup(vSwapped, "D", "who", true);
  process.stdout.write(`D(C,B): who 来自 ${after.lookup.provider}，被遮蔽 ${JSON.stringify(after.lookup.shadowed)}\n`);
  const swappedReportId = after.reportId;

  hr("案例 3：A(X,Y)、B(Y,X)、Z(A,B) 无一致线性化");
  const v3 = svc.importDeclarations(
    [
      { name: "X", parents: [], methods: [] },
      { name: "Y", parents: [], methods: [] },
      { name: "A", parents: ["X", "Y"], methods: [] },
      { name: "B", parents: ["Y", "X"], methods: [] },
      { name: "Z", parents: ["A", "B"], methods: [] },
    ],
    "顺序矛盾",
  ).version;
  const conflict = svc.linearization(v3, "Z");
  process.stdout.write(`Z 线性化 ok=${conflict.ok}\n${conflict.conflict?.message}\n`);
  for (const round of conflict.rounds) {
    for (const trial of round.trials) {
      if (!trial.accepted) {
        process.stdout.write(
          `  被拒候选 ${trial.candidate.padEnd(4)} 阻挡尾部 ${JSON.stringify(trial.blockedBy)}\n`,
        );
      }
    }
  }

  hr("案例 4：模拟服务重启 —— 关闭数据库后重新打开，按旧版本/旧报告复算");
  store.close();
  store = new Store(DEMO_DB);
  svc = new AnalysisService(store);
  process.stdout.write(`重启后版本列表: ${svc.listVersions().map((x) => x.version).join(", ")}\n`);
  process.stdout.write(`算法版本: ${ALGORITHM_VERSION}\n`);
  const replay = svc.exportReport(swappedReportId!, true);
  process.stdout.write(
    `旧报告 #${replay.reportId}（版本 ${replay.version}）复算: who 来自 ${replay.lookup?.provider}\n`,
  );
  process.stdout.write(`该版本快照类数量: ${replay.snapshot?.classes.length}\n`);
  const oldLookup = svc.lookup(vSwapped, "D", "who");
  process.stdout.write(`用快照重新查找结果一致: ${oldLookup.lookup.provider === replay.lookup?.provider}\n`);
  store.close();
  process.stdout.write("\n演示完成。\n");
}

main();
