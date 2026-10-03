// 演示：菱形继承、交换父类后方法提供者变化、顺序冲突、重启后读取记录。
import { runCli } from "../dist/src/cli.js";

function step(title, args) {
  console.log(`\n=== ${title} ===`);
  console.log(`$ c3 ${args.join(" ")}`);
  runCli(args);
  process.exitCode = 0; // 部分步骤故意演示失败（冲突导入、缺失方法），重置退出码
}

step("导入菱形继承层次（版本 1）", ["import", "demo/diamond.json"]);
step("查看 A 的方法解析顺序", ["mro", "A", "--version", "1"]);
step("查看 A 的完整合并过程", ["trace", "A", "--version", "1"]);
step("查找 A.save 的提供者", ["lookup", "A", "save", "--version", "1"]);
step("查找 A.who（含被遮蔽定义者）", ["lookup", "A", "who", "--version", "1"]);
step("查找不存在的方法 A.missing", ["lookup", "A", "missing", "--version", "1"]);
step("交换 A 的父类顺序导入（版本 2）", ["import", "demo/diamond-swapped.json"]);
step("版本 2 中 A 的 MRO（父类顺序变化生效）", ["mro", "A", "--version", "2"]);
step("旧版本 1 仍按原输入复算", ["mro", "A", "--version", "1"]);
step("导入顺序矛盾层次（应失败且不落库）", ["import", "demo/conflict.json"]);
step("版本列表（冲突导入未产生新版本）", ["versions"]);
step("生成并保存版本 1 的分析报告", ["report", "--version", "1"]);
step("列出已保存报告（重启后仍在 SQLite 中）", ["reports"]);
