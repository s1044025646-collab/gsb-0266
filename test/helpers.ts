import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { Store } from "../src/store.js";
import { AnalysisService } from "../src/service.js";
import type { ClassDecl } from "../src/types.js";

let counter = 0;

export function tempService(): {
  service: AnalysisService;
  dbPath: string;
  cleanup: () => void;
} {
  const dbPath = resolve(
    tmpdir(),
    `c3-test-${process.pid}-${counter++}-${Date.now()}.sqlite`,
  );
  const store = new Store(dbPath);
  const service = new AnalysisService(store);
  return {
    service,
    dbPath,
    cleanup: () => {
      store.close();
      rmSync(dbPath, { force: true });
      for (const suffix of ["-wal", "-shm"]) {
        rmSync(dbPath + suffix, { force: true });
      }
    },
  };
}

export function decl(
  name: string,
  parents: string[] = [],
  methods: string[] = [],
): ClassDecl {
  return { name, parents, methods: [...methods].sort() };
}

/** 断言 MRO 无重复元素。 */
export function assertNoDuplicates(mro: string[]): void {
  if (new Set(mro).size !== mro.length) {
    throw new Error(`MRO 出现重复元素: ${JSON.stringify(mro)}`);
  }
}

/**
 * 断言局部优先关系：对每个类，其 MRO 中自身在所有祖先之前，
 * 且直接父类按声明顺序的优先级被保留（父 i 在父 j 之前，i<j）。
 */
export function assertLocalPrecedence(
  classes: ClassDecl[],
  mroByClass: Map<string, string[]>,
): void {
  const byName = new Map(classes.map((c) => [c.name, c]));
  for (const c of classes) {
    const mro = mroByClass.get(c.name)!;
    if (mro[0] !== c.name) {
      throw new Error(`${c.name} 的 MRO 队首不是自身: ${JSON.stringify(mro)}`);
    }
    for (let i = 0; i < c.parents.length; i++) {
      for (let j = i + 1; j < c.parents.length; j++) {
        const pi = mro.indexOf(c.parents[i]!);
        const pj = mro.indexOf(c.parents[j]!);
        if (pi === -1 || pj === -1 || pi > pj) {
          throw new Error(
            `${c.name} 违反直接父类顺序: ${c.parents[i]} 应在 ${c.parents[j]} 之前，MRO=${JSON.stringify(mro)}`,
          );
        }
      }
    }
    // 父类必须在其子类（即 c）之后之外：检查每个祖先的父类也都在祖先之后
    for (const ancestorName of mro.slice(1)) {
      const ancestor = byName.get(ancestorName);
      if (!ancestor) continue;
      const idxAncestor = mro.indexOf(ancestorName);
      for (const gp of ancestor.parents) {
        const idxGp = mro.indexOf(gp);
        if (idxGp !== -1 && idxGp < idxAncestor) {
          throw new Error(
            `${c.name} 的 MRO 中 ${gp} 排在其子类 ${ancestorName} 之前: ${JSON.stringify(mro)}`,
          );
        }
      }
    }
  }
}
