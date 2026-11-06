/**
 * FloatBrowse Component - Dialog / Modal (JS runtime)
 */

import { Button } from './Button.js';
import { Icons } from '../icons/icons.js';

export class Dialog {
  static show(options) {
    const overlay = document.createElement('div');
    overlay.className = 'fb-modal-overlay';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(6, 11, 25, 0.75); backdrop-filter: blur(16px);
      display: flex; align-items: center; justify-content: center;
      z-index: 50000; opacity: 0; transition: opacity 0.2s ease;
    `;

    const card = document.createElement('div');
    card.className = 'fb-glass-card fb-modal-card';
    card.style.cssText = `
      width: 460px; max-width: 90vw; padding: 24px;
      display: flex; flex-direction: column; gap: 16px;
      transform: scale(0.95); transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    `;

    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';

    const titleEl = document.createElement('h3');
    titleEl.className = 'fb-h3';
    titleEl.textContent = options.title;
    header.appendChild(titleEl);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'fb-btn fb-btn-ghost fb-btn-icon';
    closeBtn.setAttribute('aria-label', 'Close dialog');
    closeBtn.innerHTML = Icons.close;
    header.appendChild(closeBtn);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'fb-body';
    if (typeof options.content === 'string') {
      body.innerHTML = options.content;
    } else if (options.content instanceof HTMLElement) {
      body.appendChild(options.content);
    }
    card.appendChild(body);

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex; justify-content:flex-end; gap:10px; margin-top:8px;';

    const close = () => {
      overlay.style.opacity = '0';
      card.style.transform = 'scale(0.95)';
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (options.onCancel) options.onCancel();
      }, 200);
    };

    const cancelBtn = Button.render({
      label: options.cancelLabel || 'Cancel',
      variant: 'secondary',
      onClick: () => close()
    });
    footer.appendChild(cancelBtn);

    const confirmBtn = Button.render({
      label: options.confirmLabel || 'Confirm',
      variant: options.isDestructive ? 'danger' : 'primary',
      onClick: async () => {
        if (options.onConfirm) await options.onConfirm();
        close();
      }
    });
    footer.appendChild(confirmBtn);
    card.appendChild(footer);

    overlay.appendChild(card);
    if (typeof document !== 'undefined' && document.body) {
      document.body.appendChild(overlay);
    }

    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => {
        overlay.style.opacity = '1';
        card.style.transform = 'scale(1)';
      });
    }

    closeBtn.addEventListener('click', close);

    const keyListener = (e) => {
      if (e.key === 'Escape') {
        if (typeof window !== 'undefined') window.removeEventListener('keydown', keyListener);
        close();
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', keyListener);
    }

    return { overlay, close };
  }
}
