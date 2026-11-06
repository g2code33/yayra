/**
 * FloatBrowse Component - Toggle
 */

export interface ToggleOptions {
  checked?: boolean;
  label?: string;
  description?: string;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
  id?: string;
}

export class Toggle {
  public static render(options: ToggleOptions = {}): { container: HTMLElement; checkbox: HTMLInputElement } {
    const row = document.createElement('label');
    row.className = 'fb-toggle-container fb-toggle-row';
    row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; cursor:pointer; gap:16px; user-select:none;';

    const textCol = document.createElement('div');
    textCol.style.cssText = 'display:flex; flex-direction:column; gap:2px;';

    if (options.label) {
      const lbl = document.createElement('span');
      lbl.style.cssText = 'font-weight:600; font-size:0.875rem; color:var(--fb-text-primary);';
      lbl.textContent = options.label;
      textCol.appendChild(lbl);
    }

    if (options.description) {
      const desc = document.createElement('span');
      desc.className = 'fb-body';
      desc.style.cssText = 'font-size:0.75rem; color:var(--fb-text-secondary);';
      desc.textContent = options.description;
      textCol.appendChild(desc);
    }
    row.appendChild(textCol);

    const toggleWrapper = document.createElement('div');
    toggleWrapper.className = 'fb-toggle';

    const input = document.createElement('input') as HTMLInputElement;
    input.type = 'checkbox';
    if (options.id) input.id = options.id;
    if (options.checked) input.checked = true;
    if (options.disabled) input.disabled = true;

    const slider = document.createElement('span');
    slider.className = 'fb-toggle-slider';

    toggleWrapper.appendChild(input);
    toggleWrapper.appendChild(slider);
    row.appendChild(toggleWrapper);

    input.addEventListener('change', () => {
      if (!options.disabled) {
        options.onChange?.(input.checked);
      }
    });

    return { container: row, checkbox: input };
  }
}
