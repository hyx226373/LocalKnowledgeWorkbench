---
lkw: ctx-playbook/1
id: spec-driven
name: 规格驱动
mode: preset
budgetTokens: 8000
missionPrompt: 一句话目标、不做什么、做成什么样。
slots:
  - { id: mission, name: 任务卡, mount: always, delivery: full, required: true, order: 0, prompt: 一句话目标、不做什么、做成什么样。 }
  - { id: requirements, name: 需求, mount: always, delivery: full, required: false, order: 1, prompt: 需求条目。验收可以回指编号。 }
  - { id: design, name: 设计, mount: always, delivery: full, required: false, order: 2, prompt: 做法和边界。 }
  - { id: tasks, name: 任务, mount: always, delivery: full, required: false, order: 3, prompt: 可执行的任务，回指需求号。 }
  - { id: rules, name: 约束与规则, mount: always, delivery: full, required: false, order: 4, prompt: 只写这次必须遵守的短规则。 }
  - { id: knowledge, name: 知识与参考, mount: agent, delivery: index, required: false, order: 5, prompt: 背景、规格、技能或地图。默认只给名称、为什么和何处。 }
  - { id: work, name: 工作对象, mount: auto, delivery: path, required: false, order: 6, prompt: 这次要改或要读的文件。 }
  - { id: contract, name: 产出契约, mount: always, delivery: full, required: false, order: 7, prompt: 交回物的形状、字段和禁止项。落点只听写入通道。 }
  - { id: accept, name: 验收, mount: always, delivery: full, required: false, order: 8, prompt: 追溯表：需求号、资料、怎样算做完。 }
relations: [specifies, depends, supersedes, verifies, implements]
---
规格驱动。任务卡后面是需求、设计、任务。验收槽是追溯表。
