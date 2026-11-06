/**
 * FloatBrowse Component - Button
 */

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'icon';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonOptions {
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string;
  iconPosition?: 'left' | 'right';
  disabled?: boolean;
  loading?: boolean;
  ariaLabel?: string;
  onClick?: (e: MouseEvent) => void;
  className?: string;
}

export class Button {
  public static render(options: ButtonOptions = {}): HTMLButtonElement {
    const btn = document.createElement('button') as HTMLButtonElement;
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
          options.onClick!(e);
        }
      });
    }

    return btn;
  }

  public static updateContent(btn: HTMLButtonElement, options: ButtonOptions): void {
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
