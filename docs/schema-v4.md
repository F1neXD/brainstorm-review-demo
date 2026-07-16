# 数据结构 v4

schema v4 在旧会议审阅对象之外增加版本领域对象。旧数组继续保留，旧 API 可以按原结构读取。

| 对象 | 职责 | 关键引用 |
| --- | --- | --- |
| `documentFamilies` | 同一逻辑策划案的稳定身份 | 当前修订、正式修订、关联文档 |
| `documentRevisions` | 一次真实内容修订 | 文档族、内容哈希、归档修订、检查点 |
| `checkpoints` | 某一时刻的完整工作区清单 | 文件、修订、Git 归档提交 |
| `changeSets` | 一次待审阅变更批次 | 基线检查点、目标检查点、会议、变更单元 |
| `changeUnits` | 可独立决定的确定性差异 | 原始补丁、语义分组、采纳状态 |
| `canonReleases` | 不可变的正式基线 | 候选检查点、正式 Git 引用、清单哈希 |
| `adoptionDecisions` | 采纳决定及历史 | 变更单元、操作者、时间、理由 |

## 两条状态轴

`documents[].knowledgeStatus` 继续表示资料权重：`核心 / 参考 / 忽略`。

`documents[].versionState` 表示版本状态：`当前正式 / 工作草稿 / 历史版本 / 待归类`。迁移时不推断正式版本，现有文档默认进入“工作草稿”。

## 旧快照映射

- 每个 `knowledgeSnapshot` 映射为一个来源为 `legacy-snapshot` 的检查点。
- 相同文档族和内容哈希只生成一条历史修订。
- 旧快照不自动成为当前修订或正式修订。
- 旧 `changePackage` 获得对应 `changeSetId`，原对象和字段保持不变。

## 迁移保证

- 迁移 ID 固定为 `schema-v4-version-management`，重复运行不生成重复对象。
- 写入前完整备份原始 `store.json` 并校验 SHA-256。
- 新文件通过同目录临时文件原子替换；写入失败时原文件不变。
- 高于程序支持版本的数据会被拒绝，不会被降级覆盖。
