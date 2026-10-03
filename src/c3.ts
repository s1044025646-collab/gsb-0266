/** C3 线性化核心实现（不依赖任何现成继承分析库）。 */

export interface MergeStep {
  round: number;
  /** 本轮开始时的非空候选序列（快照）。 */
  sequences: string[][];
  /** 本轮按固定顺序尝试的候选队首。 */
  candidate: string;
  accepted: boolean;
  /** 拒绝原因：候选出现在这些序列的尾部。 */
  blockedBy?: { sequenceIndex: number; tail: string[] }[];
}

export type LinearizeResult =
  | { ok: true; order: string[]; steps: MergeStep[] }
  | { ok: false; reason: string; remainingHeads: string[]; steps: MergeStep[] };

class SubConflict extends Error {
  constructor(public readonly cls: string) {
    super(`sub-conflict: ${cls}`);
  }
}

/**
 * 计算 L(C)：C 开头，合并各直接父类的线性化序列与直接父类列表。
 * 每轮按候选序列固定顺序尝试队首；若队首出现在任一序列尾部则被拒绝；
 * 全部被阻挡则报告冲突（不退化为拓扑排序/DFS）。
 */
export function linearize(
  name: string,
  parentsOf: (cls: string) => string[],
  cache: Map<string, string[]> = new Map()
): LinearizeResult {
  const steps: MergeStep[] = [];
  try {
    const order = mergeWithTrace(name, parentsOf, cache, steps);
    return { ok: true, order, steps };
  } catch (e) {
    if (e instanceof SubConflict) {
      return {
        ok: false,
        reason: `无法为类 ${name} 构造一致的 C3 线性化：所有候选队首均被其他序列尾部阻挡（局部优先顺序矛盾，涉及 ${e.cls}）。`,
        remainingHeads: e.message.startsWith("heads:") ? e.message.slice(6).split(",") : [],
        steps,
      };
    }
    throw e;
  }
}

function mergeWithTrace(
  name: string,
  parentsOf: (cls: string) => string[],
  cache: Map<string, string[]>,
  steps: MergeStep[]
): string[] {
  const parents = parentsOf(name);
  const parentLins: string[][] = parents.map((p) => {
    const hit = cache.get(p);
    if (hit) return hit;
    const sub = mergeWithTrace(p, parentsOf, cache, steps);
    return sub;
  });
  const sequences: string[][] = [...parentLins.map((s) => [...s]), [...parents]];
  const result: string[] = [name];
  while (true) {
    const nonEmpty = sequences.filter((s) => s.length > 0);
    if (nonEmpty.length === 0) break;
    let picked = false;
    for (let i = 0; i < sequences.length; i++) {
      const seq = sequences[i];
      if (seq.length === 0) continue;
      const head = seq[0];
      const blockedBy: { sequenceIndex: number; tail: string[] }[] = [];
      for (let j = 0; j < sequences.length; j++) {
        const tail = sequences[j].slice(1);
        if (tail.includes(head)) blockedBy.push({ sequenceIndex: j, tail });
      }
      if (blockedBy.length === 0) {
        steps.push({ round: steps.length + 1, sequences: nonEmpty.map((s) => [...s]), candidate: head, accepted: true });
        for (const s of sequences) if (s[0] === head) s.shift();
        result.push(head);
        picked = true;
        break;
      }
      steps.push({ round: steps.length + 1, sequences: nonEmpty.map((s) => [...s]), candidate: head, accepted: false, blockedBy });
    }
    if (!picked) {
      const heads = nonEmpty.map((s) => s[0]);
      const err = new SubConflict(name);
      err.message = `heads:${heads.join(",")}`;
      throw err;
    }
  }
  cache.set(name, result);
  return result;
}

/** 检测继承环，返回实际环路径（如 [A, B, C, A]），无环返回 null。 */
export function findCycle(names: string[], parentsOf: (cls: string) => string[]): string[] | null {
  const state = new Map<string, number>(); // 0=未访问 1=在栈中 2=完成
  const stack: string[] = [];
  const dfs = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const p of parentsOf(n)) {
      const st = state.get(p) ?? 0;
      if (st === 1) {
        const idx = stack.indexOf(p);
        return [...stack.slice(idx), p];
      }
      if (st === 0) {
        const r = dfs(p);
        if (r) return r;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of names) {
    if ((state.get(n) ?? 0) === 0) {
      const r = dfs(n);
      if (r) return r;
    }
  }
  return null;
}
