import React from 'react';
import type { SkillAttachRef } from '../../shared/skillDistill';
import type { SkillLibraryView } from '../../shared/skillLibrary';

export function SkillList({
  skillOn,
  skills,
  attach,
  onSkill,
  onFull,
}: {
  skillOn: boolean;
  skills: SkillLibraryView;
  attach: readonly SkillAttachRef[];
  onSkill: (name: string, on: boolean) => void;
  onFull: (name: string, on: boolean) => void;
}) {
  const chosen = (name: string) => attach.find((item) => item.name === name);
  const empty = skills.ready.length + skills.pending.length + skills.misplaced.length === 0;
  return (
    <section className="rb-skills" aria-label="Skills">
      <div className="rb-tree-row"><strong>Skills</strong></div>
      {skills.ready.map((skill) => {
        const row = chosen(skill.name);
        return (
          <div key={skill.name} className="rb-skill">
            <label className="rb-check">
              <input type="checkbox" disabled={!skillOn} checked={Boolean(row)} aria-label={skill.name} onChange={(event) => onSkill(skill.name, event.target.checked)} />
              {skill.name} · {skill.whenToUse}
            </label>
            <label className="rb-check rb-skill-full">
              <input type="checkbox" disabled={!skillOn} checked={row?.full === true} aria-label={`${skill.name} 附带全文`} onChange={(event) => onFull(skill.name, event.target.checked)} />
              附带全文
            </label>
          </div>
        );
      })}
      {skills.pending.map((skill) => <p key={skill.name}>{skill.name}：未就绪。{skill.reason}</p>)}
      {skills.misplaced.map((skill) => <p key={skill.rel}>{skill.rel}：误放。{skill.reason}</p>)}
      {empty ? <small>还没有 skill。</small> : null}
    </section>
  );
}
