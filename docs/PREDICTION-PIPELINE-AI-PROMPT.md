# 梅花直播预测流水线：三层结构与 AI 提示词（V2.3）

本文档是数字人直播间的“稳定预测流程”规范。目标：预测准确性与稳定性最大化，且模型在多次回答后不产生幻觉。原则只有一条——**AI 只负责“把结论说成话”，绝不参与起卦、绝不做额外推理**。

```
┌──────────────────────────────────────────────────┐
│ 第①层 确定性算法层（纯代码，无 AI）                │
│ 输入：粉丝昵称 → NFKC 规范化 → 码位求和          │
│ 输出：本卦、互卦、变卦、动爻、体卦、用卦          │
│ 准确率：100%（数学运算，无误差，可复现）           │
├──────────────────────────────────────────────────┤
│ 第②层 规则引擎层（代码 + 结构化知识表，无 AI）      │
│ 输入：卦象数据 + 问题关键词/审核分类               │
│ 输出：体用生克结论、吉凶方向、分类断语要点、时机    │
│ 准确率：极高（固定规则表，确定性判断）              │
├──────────────────────────────────────────────────┤
│ 第③层 话术生成层（LLM）                           │
│ 输入：第②层结构化结论 + 用户问题 + 昵称 + 时长档    │
│ 输出：自然口语口播文案（英语 / 西语 / 多语言）      │
│ ⚠️ LLM 只把结论写成话，任何新增内容即幻觉           │
└──────────────────────────────────────────────────┘
```

## 第①层：昵称确定性起卦（`packages/meihua-engine`）

同一粉丝昵称在任何时刻、任何机器上起出的卦完全一致，这是“稳定性”的第一来源。

换算规则（已实现并测试）：

1. `normalized = username.normalize('NFKC').toLocaleLowerCase()`
2. `S1 = Σ Unicode 码位`（上卦数 = S1 ÷ 8 取余，余 0 按坤）
3. `S2 = Σ (位置+1) × 码位`（下卦数 = S2 ÷ 8 取余）
4. `S3 = S1 + S2 + 字符数`（动爻 = S3 ÷ 6 取余，余 0 按第 6 爻）

随后走标准数字起卦口径得出六爻与三卦。空昵称回退时间起卦（UTC+8 墙钟）。证据与约束：

- 昵称 → 三个数 → 卦的每个环节都有 `provenance.inputs` 记录，可审计。
- 双引擎（legacy 与 mingyu-core 规范引擎）对同一昵称输出完全一致（测试覆盖）。
- **任何 AI 不得参与本层**：起卦入口不接受 LLM 输出作为种子。

## 第②层：规则结论层（`packages/answer-composer` → `concludeReading`）

本层把卦象事实编译成“允许口播的完整事实集”（`MeihuaConclusion`）：

| 字段 | 内容 | 规则来源 |
|---|---|---|
| `hexagram` | 本卦/互卦/变卦名与序号、动爻 | 第①层输出，原样转述 |
| `tiYong` | 体用卦名、生克关系（support/invest/control/resist/balance） | 五行生克固定表 |
| `direction` | FAVORABLE / CAUTION / INVEST / CONTROLLABLE / BALANCED | 由生克关系映射 |
| `timing` | EARLY（动爻 1–3） / LATER（动爻 4–6） | 动爻位置固定规则 |
| `category` | 问题分类（事业/感情/学业/生活/财运/其他/风险） | 审核层分类结果 |
| `judgmentPoints` | 方向句 + 分类断语句 + 时机句（按语言本地化） | 固定文案表 |
| `facts` | 可追溯到结构化卦象事实的最小集 | 自动生成 |

要点：**LLM 拿到的只有这个结论对象**，不再看到原始卦象结果，从结构上消除“模型自己发挥”的空间。`judgmentPoints` 全部来自固定文案表，跨语言（英/西/中/法/德/日/韩/葡/俄）逐句可查。

## 第③层：LLM 话术提示词（`OpenAICompatibleAnswerComposer` 内建）

以下 system prompt 已写入项目代码（`packages/answer-composer/src/index.ts`），等效英文原文：

```
You are the voice layer of a deterministic divination pipeline. The structured
`conclusion` is the complete truth set produced by fixed rules.

Hard rules:
1. NEVER add, change, or invent hexagram names, moving lines, 体用 relations,
   outcomes, guaranteed results, past events, or medical/legal/financial
   advice. The conclusion is final; your job is only to phrase it.
2. Do not reason beyond the conclusion, do not chain new deductions, and do not
   mention what the raw cast "might also mean". Every claim must be traceable
   to a fact in the conclusion.
3. Style: English → natural spoken US TikTok style: casual, warm, entertaining,
   concise, no formality. Spanish → warm natural conversational style for
   Latin American audiences. Other languages → natural spoken style. Never
   sound like a translated document.
4. The combined opening + speech + closing MUST stay inside the supplied
   lengthTarget minimum and maximum (words or characters per unit); do not
   count punctuation.
5. Return only JSON matching the schema.
```

用户侧消息只包含：`username`、`question`、`language`、`targetSeconds`、`lengthTarget`、`conclusion`。请求经 `response_format: json_schema, strict: true` 约束，温度 0.35。

### 反幻觉的五道闸门

1. **输入闸**：LLM 只见结论对象，不见原始排盘字段（测试断言 `meihua` 字段不在请求中）。
2. **硬规则闸**：system prompt 明令禁止新增/修改任何卦象事实与保证性结论。
3. **长度闸**：全文必须落在 `lengthTarget` 区间，防止注水式发挥。
4. **结构闸**：JSON Schema 严格模式，输出字段固定。
5. **回退闸**：外部 LLM 失败或超时自动回退本地规则合成器（同样只使用第②层结论）。

## 时长档位与语速

固定档位 20 / 30 / 40 / 60 秒（可在读取档配置 90 秒）。第②层按档位选择文案句数；合成 WAV 后按实测时长校正语速与文本长度（`TTS_DURATION_CORRECTED` 指标）。28–46 秒档会在开场回显观众提问（TikTok 互动惯例）。

## 测试与验收（均已在仓库内实现）

| 项 | 证据 |
|---|---|
| 昵称确定性（同昵称→同卦、跨引擎一致、空昵称回退） | `packages/meihua-engine` 4 项测试 |
| 结论层确定性、方向映射、分类断语（英/西/中）、时机分桶 | `packages/answer-composer` 3 项测试 |
| LLM 请求只含结论、不含原始卦象、含硬规则提示词 | `packages/answer-composer` 1 项测试 |
| 流水线 provenance 为 NICKNAME 且记录昵称 | `apps/orchestrator` 端到端断言 |
| 全仓回归 | 117 项测试 + typecheck + build |

## 禁止事项（红线）

- 不得用 LLM 生成起卦种子或直接让 LLM 排盘。
- 不得让 LLM 输出分类或结论（审核分类由规则审核层完成）。
- 不得在口播中加入确定性承诺（“一定会/肯定会”）、医疗/法律/财务建议。
- 不得移除免责声明（口播结尾 + 舞台常驻）。
- 外部 LLM/语音接入前必须通过真实密钥试音与调用验证，升级状态分级见 `docs/V2.2-IMPLEMENTATION-STATUS.md`。