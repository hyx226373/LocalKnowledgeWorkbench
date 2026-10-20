---
lkw: ctx-playbook/1
id: skill-reuse
name: 复用 skill
mode: preset
budgetTokens: 8000
missionPrompt: 一句话目标、不做什么、做成什么样。
slots:
  - { id: mission, name: 任务卡, mount: always, delivery: full, required: true, order: 0, prompt: 一句话目标、不做什么、做成什么样。 }
  - { id: rules, name: 约束与规则, mount: always, delivery: full, required: false, order: 1, prompt: 只写这次必须遵守的短规则。 }
  - { id: knowledge, name: 知识与参考, mount: agent, delivery: index, required: false, order: 2, prompt: 这里放技能。附带全文与蒸馏共用，粘贴里全文只出现一次。 }
  - { id: work, name: 工作对象, mount: auto, delivery: path, required: false, order: 3, prompt: 这次要改或要读的文件。 }
  - { id: contract, name: 产出契约, mount: always, delivery: full, required: false, order: 4, prompt: 交回物的形状、字段和禁止项。落点只听写入通道。 }
  - { id: accept, name: 验收, mount: always, delivery: full, required: false, order: 5, prompt: 怎样算做完。每条可以回指需求和资料。 }
relations: [specifies, depends, supersedes, verifies, implements]
---
复用 skill。知识槽即技能。附带全文与蒸馏共用，粘贴只出现一次。
