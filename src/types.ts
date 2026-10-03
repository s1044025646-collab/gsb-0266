/**
 * 领域类型定义。
 *
 * 本服务只分析“类声明”：类名、按声明顺序排列的直接父类、本类自行定义的方法名。
 * 不加载 Python 模块、不执行任何用户代码，也不实现对象系统。
 */

/** 单条类声明（输入形态，携带声明所在文件行号，仅用于报错定位）。 */
export interface ClassDeclInput {
  name: string;
  /** 直接父类，顺序有意义，线性化时绝不重排。 */
  parents: string[];
  /** 本类自行定义的方法名，去重后保存；顺序不影响结果。 */
  methods: string[];
  /** 声明在输入文件中的行号（从 1 开始），可选。 */
  line?: number;
}

/** 校验通过后规范化的类声明。 */
export interface ClassDecl {
  name: string;
  parents: string[];
  methods: string[];
}

/** 一整套声明快照（version 的载荷）。 */
export interface DeclSnapshot {
  version: number;
  algorithmVersion: string;
  createdAt: string;
  note: string;
  classes: ClassDecl[];
}

/** 合并过程中单个候选的判定结果。 */
export interface MergeTrial {
  /** 候选类名。 */
  candidate: string;
  /** 是否被选中。 */
  accepted: boolean;
  /** 被拒绝时，阻挡该候选的剩余序列尾部（候选出现在这些序列的非队首位置）。 */
  blockedBy: string[][];
  /** 被拒绝时，人类可读的阻挡说明。 */
  reason: string | null;
}

/** 合并算法的一轮。 */
export interface MergeRound {
  /** 本轮开始时各候选序列的内容（队首在前）。 */
  sequencesBefore: string[][];
  /** 本轮依次尝试的候选及其判定。 */
  trials: MergeTrial[];
  /** 本轮最终选中的类；冲突轮为 null。 */
  selected: string | null;
}

/** 单个类的 C3 线性化结果。 */
export interface LinearizationResult {
  className: string;
  /** 成功时的方法解析顺序（MRO）；冲突时为 null。 */
  mro: string[] | null;
  ok: boolean;
  /** 顶层合并过程（直接父类序列的合并）。 */
  rounds: MergeRound[];
  /** 冲突说明（ok=false 时有值）。 */
  conflict: ConflictInfo | null;
  /** 计算时依赖的各父类线性化（便于解释）。 */
  parentMros: Record<string, string[]>;
}

export interface ConflictInfo {
  /** 冲突发生时剩余的候选序列。 */
  remainingSequences: string[][];
  /** 本轮被全部拒绝的候选及阻挡尾部。 */
  rejectedTrials: MergeTrial[];
  message: string;
}

/** 方法查找结果。 */
export interface MethodLookupResult {
  className: string;
  method: string;
  found: boolean;
  /** 最终提供该方法的类（MRO 中第一个定义者）。 */
  provider: string | null;
  /** 被遮蔽的其他定义者，按 MRO 顺序。 */
  shadowed: { className: string; order: number }[];
  /** 查找所用的 MRO。 */
  mro: string[];
}

/** 导出报告（可按原输入复算，自包含）。 */
export interface AnalysisReport {
  reportId: number | null;
  version: number;
  algorithmVersion: string;
  generatedAt: string;
  targetClass: string | null;
  method: string | null;
  linearization: LinearizationResult | null;
  lookup: MethodLookupResult | null;
  /** 复算所用的完整声明快照。 */
  snapshot: DeclSnapshot | null;
}
