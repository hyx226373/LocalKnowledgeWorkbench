import { describe, expect, it } from 'vitest';
import { acceleratorFromInput } from '../src/main/keybindingsForward';

describe('acceleratorFromInput', () => {
  it('规范化', () => {
    expect(
      acceleratorFromInput({ key: 'p', code: 'KeyP', control: true, alt: false, shift: true, meta: false }),
    ).toBe('Ctrl+Shift+P');
    expect(acceleratorFromInput({ key: 'Control', code: 'ControlLeft', control: true, alt: false, shift: false, meta: false })).toBeNull();
  });
});
