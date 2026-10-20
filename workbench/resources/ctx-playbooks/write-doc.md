---
lkw: ctx-playbook/1
id: write-doc
name: 写文档
mode: preset
budgetTokens: 8000
missionPrompt: 一句话目标、不做什么、做成什么样。
slots:
  - { id: mission, name: 任务卡, mount: always, delivery: full, required: true, order: 0, prompt: 一句话目标、不做什么、做成什么样。 }
  - { id: rules, name: 约束与规则, mount: always, delivery: full, required: false, order: 1, prompt: 读者是谁、文风怎样。只写这次必须遵守的。 }
  - { id: knowledge, name: 知识与参考, mount: agent, delivery: index, required: false, order: 2, prompt: 背景、规格、技能或地图。默认只给名称、为什么和何处。 }
  - { id: work, name: 工作对象, mount: auto, delivery: path, required: false, order: 3, prompt: 这次要改或要读的文件。 }
  - { id: contract, name: 产出契约, mount: always, delivery: full, required: false, order: 4, prompt: 交回物的形状、字段和禁止项。落点只听写入通道。 }
  - { id: accept, name: 验收, mount: always, delivery: full, required: false, order: 5, prompt: 怎样算做完。每条可以回指需求和资料。 }
relations: [specifies, depends, supersedes, verifies, implements]
---
写文档。规则槽改成读者和文风。
