/**
 * FloatBrowse Component - Button (JS runtime)
 */

export class Button {
  static render(options = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';

    const variant = options.variant || 'primary';
    const size = options.size || 'md';

    const classes = ['fb-btn', `fb-btn-${variant}`, `fb-btn-${size}`];
    if (options.className) classes.push(options.className);
    if (variant === 'icon') classes.push('fb-btn-icon');
    if (options.loading) classes.push('fb-btn-loading');

    btn.className = classes.join(' ');
    if (options.ariaLabel) btn.setAttribute('aria-label', options.ariaLabel);
    if (options.disabled || options.loading) btn.disabled = true;

    this.updateContent(btn, options);

    if (options.onClick) {
      btn.addEventListener('click', (e) => {
        if (!options.disabled && !options.loading) {
          options.onClick(e);
        }
      });
    }

    return btn;
  }

  static updateContent(btn, options) {
    if (options.loading) {
      btn.innerHTML = `<span class="fb-spinner-sm"></span> <span>${options.label || ''}</span>`;
      btn.disabled = true;
      return;
    }

    const iconHtml = options.icon ? `<span class="fb-btn-icon-slot">${options.icon}</span>` : '';
    const labelHtml = options.label ? `<span>${options.label}</span>` : '';

    if (options.iconPosition === 'right') {
      btn.innerHTML = `${labelHtml}${iconHtml}`;
    } else {
      btn.innerHTML = `${iconHtml}${labelHtml}`;
    }
  }
}
