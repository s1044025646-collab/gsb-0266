import {
  type ClassDecl,
  type ConflictInfo,
  type LinearizationResult,
  type MergeRound,
  type MergeTrial,
} from "./types.js";

export const ALGORITHM_VERSION = "c3-1.0.0";

export type ClassMap = ReadonlyMap<string, ClassDecl>;

/**
 * 计算单个类的 C3 线性化。
 *
 *   L(C) = C + merge(L(P1), ..., L(Pn), [P1, ..., Pn])
 *
 * merge 每轮按“候选序列的固定顺序”取各序列队首作为候选依次尝试：
 * 候选不得出现在任何剩余序列的尾部（即除队首外的位置）。
 * 第一个满足条件的候选被选中，并从所有序列的队首移除。
 * 若所有候选都被阻挡，则报告线性化冲突（绝不退化为拓扑排序/DFS）。
 *
 * 调用方必须保证声明无缺失父类、无环；父类线性化按父类顺序递归计算。
 */
export class C3Analyzer {
  private readonly cache = new Map<string, LinearizationResult>();

  constructor(private readonly classes: ClassMap) {}

  static fromArray(decls: ClassDecl[]): C3Analyzer {
    const map = new Map<string, ClassDecl>();
    for (const d of decls) map.set(d.name, d);
    return new C3Analyzer(map);
  }

  linearize(className: string): LinearizationResult {
    const hit = this.cache.get(className);
    if (hit) return hit;

    const decl = this.classes.get(className);
    if (!decl) {
      throw new Error(`linearize: 类不存在 ${className}`);
    }

    const parentMros: Record<string, string[]> = {};
    if (decl.parents.length === 0) {
      const result: LinearizationResult = {
        className,
        mro: [className],
        ok: true,
        rounds: [],
        conflict: null,
        parentMros,
      };
      this.cache.set(className, result);
      return result;
    }

    // 递归先算父类（父类顺序固定）。任一父类冲突则本类也无法成功。
    for (const p of decl.parents) {
      const parentResult = this.linearize(p);
      if (!parentResult.ok || !parentResult.mro) {
        const result: LinearizationResult = {
          className,
          mro: null,
          ok: false,
          rounds: [],
          conflict: {
            remainingSequences: [],
            rejectedTrials: [],
            message: `直接父类 ${p} 自身线性化冲突，${className} 无法构造一致 MRO`,
          },
          parentMros,
        };
        this.cache.set(className, result);
        return result;
      }
      parentMros[p] = parentResult.mro;
    }

    const seedSequences: string[][] = [
      ...decl.parents.map((p) => [...(parentMros[p] ?? [p])]),
      [...decl.parents],
    ];

    const merge = mergeSequences(seedSequences);
    const result: LinearizationResult = {
      className,
      mro: merge.ok ? [className, ...merge.order] : null,
      ok: merge.ok,
      rounds: merge.rounds,
      conflict: merge.conflict,
      parentMros,
    };
    this.cache.set(className, result);
    return result;
  }
}

interface MergeOutput {
  ok: boolean;
  order: string[];
  rounds: MergeRound[];
  conflict: ConflictInfo | null;
}

/**
 * C3 merge 核心：返回最终合并顺序与每轮候选判定（含被拒绝候选及阻挡尾部）。
 */
export function mergeSequences(initial: string[][]): MergeOutput {
  // 全程保留空槽以稳定“候选序列的固定顺序”；用快照记录每轮开始状态。
  const seqs: (string[] | null)[] = initial.map((s) => [...s]);
  const order: string[] = [];
  const rounds: MergeRound[] = [];

  const alive = (): string[][] =>
    seqs.filter((s): s is string[] => s !== null && s.length > 0);

  while (alive().length > 0) {
    const before = alive().map((s) => [...s]);
    const trials: MergeTrial[] = [];
    let selected: string | null = null;

    // 候选按序列固定顺序取队首；同一轮内已试过的队首不重复试。
    const tried = new Set<string>();
    for (const seq of alive()) {
      const head = seq[0];
      if (head === undefined || tried.has(head)) continue;
      tried.add(head);

      const blockedBy = tailsContaining(alive(), head);
      if (blockedBy.length === 0) {
        trials.push({ candidate: head, accepted: true, blockedBy: [], reason: null });
        selected = head;
        break;
      }
      trials.push({
        candidate: head,
        accepted: false,
        blockedBy,
        reason: `候选 ${head} 出现在剩余序列尾部 ${JSON.stringify(blockedBy)}，本轮被阻挡`,
      });
    }

    rounds.push({ sequencesBefore: before, trials, selected });

    if (selected === null) {
      const rejected = trials.filter((t) => !t.accepted);
      return {
        ok: false,
        order,
        rounds,
        conflict: {
          remainingSequences: before,
          rejectedTrials: rejected,
          message:
            "C3 线性化冲突：所有候选队首都出现在某个剩余序列的尾部，" +
            `被拒绝候选=[${rejected.map((t) => t.candidate).join(", ")}]，` +
            "无法构造满足局部优先顺序的一致 MRO",
        },
      };
    }

    // 从所有序列队首移除被选项；变空的序列退出合并。
    for (let i = 0; i < seqs.length; i++) {
      const seq = seqs[i];
      if (seq && seq[0] === selected) {
        seq.shift();
        if (seq.length === 0) seqs[i] = null;
      }
    }
    order.push(selected);
  }

  return { ok: true, order, rounds, conflict: null };
}

/**
 * 若 candidate 出现在任一剩余序列的尾部（索引 >= 1），返回这些尾部。
 */
function tailsContaining(sequences: string[][], candidate: string): string[][] {
  const blocked: string[][] = [];
  for (const seq of sequences) {
    if (seq.slice(1).includes(candidate)) blocked.push(seq.slice(1));
  }
  return blocked;
}
