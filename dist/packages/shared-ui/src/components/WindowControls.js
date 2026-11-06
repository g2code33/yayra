/**
 * FloatBrowse Component - WindowControls (JS runtime)
 */

import { Icons } from '../icons/icons.js';

export class WindowControls {
  static render(options = {}) {
    const container = document.createElement('div');
    const platform = options.platform || 'windows';
    const variant = options.styleVariant || (platform === 'linux' ? 'linux' : 'windows');

    container.className = `fb-window-controls fb-window-controls-${platform} fb-window-controls-${variant}`;
    container.style.cssText = 'display:flex; align-items:center; gap:6px;';

    if (variant === 'mac') {
      container.innerHTML = `
        <button class="fb-traffic-btn fb-traffic-close" title="Close" aria-label="Close window" style="width:12px; height:12px; border-radius:50%; background:#ef4444; border:none; cursor:pointer;"></button>
        <button class="fb-traffic-btn fb-traffic-min" title="Minimize" aria-label="Minimize window" style="width:12px; height:12px; border-radius:50%; background:#f59e0b; border:none; cursor:pointer;"></button>
        <button class="fb-traffic-btn fb-traffic-max" title="Maximize" aria-label="Maximize window" style="width:12px; height:12px; border-radius:50%; background:#10b981; border:none; cursor:pointer;"></button>
      `;

      container.querySelector('.fb-traffic-close')?.addEventListener('click', () => options.onClose?.());
      container.querySelector('.fb-traffic-min')?.addEventListener('click', () => options.onMinimize?.());
      container.querySelector('.fb-traffic-max')?.addEventListener('click', () => options.onMaximize?.());
      return container;
    }

    if (options.onPinToggle !== undefined) {
      const pinBtn = document.createElement('button');
      pinBtn.className = `fb-btn fb-btn-ghost fb-btn-icon ${options.isPinned ? 'active' : ''}`;
      pinBtn.setAttribute('aria-label', options.isPinned ? 'Unpin from Top' : 'Pin Always on Top');
      pinBtn.title = options.isPinned ? 'Unpin from Top' : 'Pin Always on Top';
      pinBtn.innerHTML = Icons.pin;
      pinBtn.addEventListener('click', () => {
        options.onPinToggle?.(!options.isPinned);
      });
      container.appendChild(pinBtn);
    }

    const minBtn = document.createElement('button');
    minBtn.className = 'fb-btn fb-btn-ghost fb-btn-icon fb-caption-min';
    minBtn.setAttribute('aria-label', 'Minimize');
    minBtn.title = 'Minimize';
    minBtn.innerHTML = Icons.minimize;
    minBtn.addEventListener('click', () => options.onMinimize?.());
    container.appendChild(minBtn);

    const maxBtn = document.createElement('button');
    maxBtn.className = 'fb-btn fb-btn-ghost fb-btn-icon fb-caption-max';
    maxBtn.setAttribute('aria-label', options.isMaximized ? 'Restore' : 'Maximize');
    maxBtn.title = options.isMaximized ? 'Restore' : 'Maximize';
    maxBtn.innerHTML = options.isMaximized ? Icons.restore : Icons.maximize;
    maxBtn.addEventListener('click', () => options.onMaximize?.());
    container.appendChild(maxBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'fb-btn fb-btn-ghost fb-btn-icon fb-caption-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.title = 'Close';
    closeBtn.style.color = '#ef4444';
    closeBtn.innerHTML = Icons.close;
    closeBtn.addEventListener('click', () => options.onClose?.());
    container.appendChild(closeBtn);

    return container;
  }
}
