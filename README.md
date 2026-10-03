# C3 多重继承线性化与方法查找解释后端

一个离线、纯本地的类层次**声明分析**服务：输入一组类名、按声明顺序排列的直接父类以及各类自行定义的方法名，即可查询任意类的 C3 方法解析顺序（MRO）、完整合并过程，以及某个方法最终由哪个类提供。

只做声明分析：**不加载 Python 模块、不执行用户方法、不实现编程语言/虚拟机/对象系统**，也不实现 `super` 调用、重载签名或元类规则。

## 技术栈与运行环境

- TypeScript + Node.js（>= 22.5，使用内置 `node:sqlite`，无需原生编译）
- SQLite 持久化（数据库文件在项目内 `data/c3.db`，可用环境变量 `C3_DB` 覆盖）
- 仅监听 `127.0.0.1`，不依赖 Docker / WSL / 付费服务 / 外部在线 API
- Windows 本地直接运行

## 快速开始

```powershell
npm install        # 安装开发依赖（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部自动化测试
npm start          # 启动 HTTP API（默认自动选择空闲端口）
npm run cli -- versions          # CLI：列出版本
node demo/demo.js  # 端到端演示（菱形、父类交换、顺序冲突、报告）
```

## 支持范围

- C3 线性化：`L(C) = C + merge(L(p1)..L(pn), [p1..pn])`，每轮按候选序列固定顺序尝试队首，队首出现在任一序列尾部则被拒绝并记录；全部被阻挡则报告线性化冲突（不退化为拓扑排序或 DFS）。
- 无父类的类线性化只包含自己；共享祖先在最终顺序中只出现一次。
- 方法查找：按成功线性化顺序返回第一个定义者，并列出被遮蔽的其他定义者；未定义返回未找到；线性化冲突的类不允许查找。
- 版本化快照：每次导入生成新版本；修改父类顺序产生新版本；旧版本报告仍可按原输入复算。
- 批量导入先完整校验再单事务落库，失败不留下半套声明。
- 合并过程包含每一步的候选、是否接受、被拒绝时的阻挡尾部。

### 限制（合理假设）

- 类名/方法名：区分大小写标识符（`[A-Za-z_][A-Za-z0-9_]*`），长度 1–64。
- 类数量上限 1000，每类方法上限 500。
- 同一类内重复方法名自动去重；重复直接父类视为错误。

## 错误码

| 错误码 | 含义 |
| --- | --- |
| `E_INVALID_NAME` | 类名/方法名非法 |
| `E_INVALID_INPUT` | 请求格式非法 |
| `E_TOO_MANY_CLASSES` | 类数量超限 |
| `E_DUPLICATE_CLASS` | 重复类名 |
| `E_DUPLICATE_PARENT` | 重复直接父类 |
| `E_MISSING_PARENT` | 引用了未声明的父类 |
| `E_SELF_INHERITANCE` | 类继承自身 |
| `E_CYCLE` | 继承环（消息中含实际环路径，如 `A -> B -> C -> A`） |
| `E_CONFLICT` | 无环但顺序矛盾，无一致线性化（含被阻挡的剩余队首） |
| `E_CLASS_NOT_FOUND` / `E_VERSION_NOT_FOUND` / `E_METHOD_NOT_FOUND` | 资源不存在 |

## CLI

```powershell
npm run cli -- import demo/diamond.json   # 导入声明，生成新版本
npm run cli -- versions                   # 列出所有版本
npm run cli -- classes --version 1        # 查看某版本的类关系
npm run cli -- show A --version 1         # 查看单个类声明
npm run cli -- mro A --version 1          # 方法解析顺序
npm run cli -- trace A --version 1        # 完整合并过程（含被拒绝候选）
npm run cli -- lookup A who --version 1   # 方法提供者与被遮蔽定义者
npm run cli -- report --version 1         # 生成并保存分析报告
npm run cli -- reports                    # 列出已保存报告
npm run cli -- serve --port 8080          # 指定端口启动（缺省自动选空闲端口）
```

## HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/imports` | 导入 `{classes:[{name,parents,methods}]}`，返回 `{version}` |
| `GET /api/versions` | 列出版本（含算法版本、类数量） |
| `GET /api/versions/:v/classes` | 查看类关系 |
| `GET /api/versions/:v/classes/:name` | 查看单个类 |
| `GET /api/versions/:v/linearize/:name` | 计算线性化并保存查询报告 |
| `GET /api/versions/:v/lookup/:name/:method` | 方法查找（提供者 + 被遮蔽者） |
| `GET /api/versions/:v/report` | 导出全量分析报告并保存 |
| `GET /api/reports` / `GET /api/reports/:id` | 查询已保存报告 |

错误响应统一为 `{ "code": "E_*", "message": "...", "details": ... }`。

## 冲突解释示例

`A(X,Y)`、`B(Y,X)`、`Z(A,B)`：合并 `L(A)=[A,X,Y]`、`L(B)=[B,Y,X]` 与 `[A,B]` 时，取 `A`、`B` 后，候选 `X` 被 `[Y,X]` 的尾部阻挡，候选 `Y` 被 `[X,Y]` 的尾部阻挡，所有队首均被阻挡，报告 `E_CONFLICT`，`remainingHeads` 为 `["X","Y"]`。这不是环，而是两个父类对 `X`、`Y` 的局部优先顺序互相矛盾，C3 无法给出一致顺序。

## 演示案例

- `demo/diamond.json`：菱形继承 `A(X,Y)`，`X`、`Y` 共祖先 `O` → MRO 为 `A X Y O`。
- `demo/diamond-swapped.json`：交换为 `A(Y,X)` → MRO 变为 `A Y X O`，`who` 的提供者随之改变。
- `demo/conflict.json`：上述 `Z(A,B)` 顺序矛盾案例，导入即报 `E_CONFLICT` 且不产生新版本。
- `demo/api-smoke.mjs`：HTTP API 冒烟脚本。
- `demo/demo.js`：完整 CLI 演示（含服务重启后从 SQLite 读取同一版本记录）。

## 项目结构

```
src/c3.ts       C3 线性化核心（合并步骤跟踪、环检测）
src/service.ts  校验、方法查找、报告生成
src/store.ts    SQLite 持久化（版本快照、算法版本、查询报告）
src/server.ts   HTTP API
src/cli.ts      命令行接口
test/           node:test 自动化测试
demo/           演示数据与脚本
data/           SQLite 数据目录
```
