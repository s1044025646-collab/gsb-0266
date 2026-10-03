# C3 多重继承线性化与方法查找解释后端

离线类层次分析服务：输入一组类声明（类名、按声明顺序排列的直接父类、本类自定义方法名），
计算指定类的 **C3 方法解析顺序（MRO）**、展示 **merge 合并过程**，并按 MRO 查找某个方法的
**最终定义者**与被遮蔽者。只做静态声明分析，**不加载 Python 模块、不执行任何用户方法、
不实现编程语言/虚拟机/对象系统、不实现 super/重载签名/元类规则**。

- 技术栈：TypeScript + Node.js（仅内置 `node:http`、`node:sqlite`）+ SQLite，零运行时第三方依赖
- 形态：只做后端，提供 HTTP API 与 CLI
- 平台：Windows 本地直接运行，不需要 Docker / WSL / 付费服务 / 外网
- 存储：项目内 `data/` 目录保存声明快照、版本、算法版本与查询报告

## 支持范围

- 类名/方法名为区分大小写的标识符：`^[A-Za-z_][A-Za-z0-9_]*$`，长度上限 128，类数量上限 1000（见 `src/declarations.ts`）。
- 直接父类**顺序有意义**，全程原样保留，绝不为排序方便而重排。
- 无父类的类 MRO 只含自身；共享祖先在最终 MRO 中只出现一次。
- 父类顺序（或任何声明内容）变化会产生**新版本**；旧报告绑定旧版本，可随时按原输入快照复算。

## C3 算法说明（本项目的实现）

```
L(C) = [C] + merge( L(P1), L(P2), …, L(Pn), [P1, P2, …, Pn] )
```

`merge` 每一轮：

1. 按**候选序列的固定顺序**（各父类线性化序列，最后是直接父类列表）依次取队首作为候选；
2. 候选不得出现在任何剩余序列的**尾部**（即该序列除队首以外的位置）；
3. 第一个不被阻挡的候选被选中，并从所有序列的队首移除，序列变空则退出合并；
4. 若所有候选都被阻挡，则报告 **C3 线性化冲突**，立即失败——**不退化为拓扑排序，也不做 DFS 猜测**。

每次合并都会记录：本轮开始时各序列内容、每个候选是否被接受、被拒绝时**阻挡它的尾部序列**与文字原因、
最终选中项。核心实现见 `src/c3.ts`，使用进程内缓存避免重复计算；没有调用任何现成 C3/MRO 库。

### 声明错误与错误码

| 错误码 | 含义 |
| --- | --- |
| `INVALID_IDENTIFIER` / `NAME_TOO_LONG` | 类名/父类名/方法名非法或超长 |
| `EMPTY_BATCH` / `TOO_MANY_CLASSES` | 空批次 / 类数量超限 |
| `DUPLICATE_CLASS` | 同一批次中重复类名（报告两处行号） |
| `DUPLICATE_PARENT` | 同一类的直接父类列表中出现重复父类 |
| `SELF_INHERITANCE` | 类把自己声明为直接父类 |
| `MISSING_PARENT` | 父类未在本批声明中定义 |
| `INHERITANCE_CYCLE` | 继承环，错误详情含实际环路径，如 `A -> B -> C -> A` |
| `C3_CONFLICT` | 无环但顺序矛盾，无法构造一致 MRO（冲突时禁止方法查找） |
| `CLASS_NOT_FOUND` / `VERSION_NOT_FOUND` | 指定类或版本不存在 |
| `INVALID_BODY` | 请求体/文件格式错误 |

注意区分：**继承环**（`A->B->A`，结构性错误，整批拒绝）与 **C3 顺序冲突**
（图无环，但父类顺序之间互相矛盾，如 `A(X,Y)`、`B(Y,X)`、`Z(A,B)`）。后者声明合法、可以落库，
但对应类没有一致 MRO，`mro=null` 且冲突类不能用于方法查找。

## 环境要求

- Node.js >= 22.5（使用内置 `node:sqlite`；开发机实测 Node 25）。
- Windows PowerShell。SQLite 数据库位于项目内 `data/c3.sqlite`，可用环境变量 `C3_DATA_DIR` 覆盖目录。

## 构建与测试

```powershell
npm install
npm run build     # tsc 编译到 dist/
npm test          # node:test + tsx 运行全部自动化测试（26 个用例）
```

## 一键演示

```powershell
npm run demo
```

演示覆盖：
1. 菱形继承共享祖先去重；
2. 交换父类顺序后方法提供者由 `B` 变为 `C`（产生新版本）；
3. `A(X,Y)`、`B(Y,X)`、`Z(A,B)` 的 C3 冲突及被拒候选/阻挡尾部；
4. 关闭并重新打开同一 SQLite 文件（模拟服务重启）后，按旧版本与旧报告复算结果一致。

## CLI 用法

声明文件支持 JSON（`[{name,parents,methods}]`）或文本格式（`examples/` 下有示例）：

```
# 注释行
O
X(O): ping
Y(O)
G(X, Y):            # 父类顺序 X 先于 Y，顺序有意义
```

可直接运行的命令（也可用 `npx tsx src/cli.ts ...` 免编译运行）：

```powershell
node dist/cli.js help
node dist/cli.js import examples/conflict.txt --note="顺序矛盾示例"
node dist/cli.js versions
node dist/cli.js relations --version=1
node dist/cli.js mro A --version=1
node dist/cli.js merge Z --version=1          # 查看合并轮次/被拒候选/阻挡尾部
node dist/cli.js lookup A ping --version=1 --persist
node dist/cli.js reports
node dist/cli.js report 1                    # 默认附带原输入快照
node dist/cli.js serve --port=8080           # 不指定 --port 时自动选择空闲端口
```

退出码约定：成功 0；方法未找到 1；用法/资源错误 2；声明校验失败 3；线性化冲突（`mro`/`merge`）2。

## HTTP API

启动后所有响应为 JSON。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/import` | 导入一批声明；先完整校验，通过后事务落库，失败不留半套数据。body：`{"note":"…","classes":[…]}` |
| `GET /api/versions` | 列出所有声明快照版本与算法版本 |
| `GET /api/versions/{v}/relations` | 各类的直接父类、直接子类、自有方法 |
| `GET /api/versions/{v}/classes/{C}/mro[?persist=1]` | 计算 MRO；`persist=1` 同时保存查询报告 |
| `GET /api/versions/{v}/classes/{C}/lookup?method=m[&persist=1]` | 方法查找：`provider` 与 `shadowed` |
| `GET /api/reports[?version=v]` | 列出查询报告 |
| `GET /api/reports/{id}[?snapshot=0]` | 导出报告；默认附原输入快照以便复算，`snapshot=0` 不附 |

cURL 示例（PowerShell）：

```powershell
node dist/cli.js serve --port=8080

$body = @'
{"note":"菱形","classes":[
  {"name":"O","parents":[],"methods":["who"]},
  {"name":"B","parents":["O"],"methods":["who"]},
  {"name":"C","parents":["O"],"methods":["who"]},
  {"name":"D","parents":["B","C"],"methods":[]}
]}
'@
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/api/import -ContentType 'application/json' -Body $body
Invoke-RestMethod 'http://127.0.0.1:8080/api/versions/1/classes/D/mro'
Invoke-RestMethod 'http://127.0.0.1:8080/api/versions/1/classes/D/lookup?method=who'
```

校验失败返回 HTTP 422，形如：

```json
{ "ok": false,
  "error": { "code": "VALIDATION_FAILED",
    "message": "…",
    "details": [ { "code": "MISSING_PARENT", "message": "…", "className": "A", "line": 3 } ] } }
```

## 方法查找语义

- 按目标类**成功线性化后的 MRO 顺序**取第一个定义该方法的类作为 `provider`；其余定义者按 MRO 顺序列入 `shadowed`（含 MRO 位次）。
- 无任何定义者时 `found=false`、`provider=null`。
- 线性化冲突的类返回 `C3_CONFLICT`（HTTP 409），不能当作可正常查找的类。

## 项目结构

| 文件 | 职责 |
| --- | --- |
| `src/c3.ts` | C3 merge 核心、合并轨迹、进程内缓存（无第三方 C3 库） |
| `src/declarations.ts` | 标识符/结构/重复/缺失/环检测等完整批量校验 |
| `src/lookup.ts` | 按 MRO 的方法定义者与遮蔽列表 |
| `src/store.ts` | SQLite 快照、版本、报告持久化 |
| `src/service.ts` | 事务导入、按版本复算、关系视图、报告导出 |
| `src/server.ts` | HTTP 路由、参数校验、空闲端口选择 |
| `src/fileformat.ts` | JSON / 文本声明文件解析（带行号） |
| `src/cli.ts` / `src/demo.ts` | CLI 入口 / 端到端演示 |
| `test/*.test.ts` | 26 个自动化测试（C3、校验、服务、HTTP） |

## 设计要点与限制

- **确定性**：持久化前对类按名排序（父类顺序保持不变），因此仅改变输入文件的行序不会改变结果，也不会产生新版本。
- **不可变快照**：每次内容变化都新增版本行，旧报告引用旧版本，永不被后续导入覆盖。
- **事务原子性**：导入在单个 SQLite 事务中写入，校验失败时无任何写入。
- 缓存只在单次分析进程内生效；跨进程/重启始终从快照重新线性化，保证结果可复现。
- 本项目只解释“声明层面的 MRO 与方法名归属”，不涉及参数签名、super 协作、多态分派或元类。
