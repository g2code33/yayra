/**
 * FloatBrowse Component - Input (JS runtime)
 */

export class Input {
  static render(options = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = `fb-input-wrapper ${options.className || ''}`;

    if (options.prefixIcon) {
      const prefix = document.createElement('span');
      prefix.className = 'fb-input-icon';
      prefix.innerHTML = options.prefixIcon;
      wrapper.appendChild(prefix);
    }

    const input = document.createElement('input');
    input.type = options.type || 'text';
    input.className = 'fb-input';
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.value) input.value = options.value;
    if (options.disabled) input.disabled = true;
    wrapper.appendChild(input);

    if (options.shortcutBadge) {
      const badge = document.createElement('span');
      badge.className = 'fb-mono';
      badge.style.cssText = 'font-size:0.6875rem; background:rgba(255,255,255,0.08); border:1px solid var(--fb-border-glass); padding:2px 6px; border-radius:4px; color:var(--fb-text-muted);';
      badge.textContent = options.shortcutBadge;
      wrapper.appendChild(badge);
    }

    if (options.suffixIcon) {
      const suffix = document.createElement('span');
      suffix.className = 'fb-input-icon';
      suffix.innerHTML = options.suffixIcon;
      wrapper.appendChild(suffix);
    }

    if (options.onInput) {
      input.addEventListener('input', () => options.onInput(input.value));
    }

    if (options.onEnter) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          options.onEnter(input.value);
        }
      });
    }

    return { container: wrapper, input };
  }
}
