/**
 * FloatBrowse Component - GlassCard (JS runtime)
 */

export class GlassCard {
  static render(contentOrOptions = {}, options = {}) {
    const card = document.createElement('div');
    let opts = {};
    let innerContent = null;

    if (typeof contentOrOptions === 'object' && contentOrOptions !== null && !('nodeType' in contentOrOptions) && !('tagName' in contentOrOptions)) {
      opts = contentOrOptions;
      innerContent = opts.content;
    } else {
      opts = options;
      innerContent = contentOrOptions;
    }

    const classes = ['fb-glass-card'];
    if (opts.variant === 'elevated') classes.push('fb-glass-card-elevated');
    if (opts.variant === 'subtle') classes.push('fb-glass-card-subtle');
    if (opts.interactive) classes.push('fb-card-interactive');
    if (opts.glowing) classes.push('fb-card-glowing');
    if (opts.className) classes.push(opts.className);

    card.className = classes.join(' ');
    if (opts.style) card.style.cssText = opts.style;

    if (opts.title || opts.subtitle) {
      const header = document.createElement('div');
      header.className = 'fb-card-header';
      header.style.cssText = 'margin-bottom: 12px;';
      if (opts.title) {
        const titleEl = document.createElement('h3');
        titleEl.className = 'fb-h3';
        titleEl.textContent = opts.title;
        header.appendChild(titleEl);
      }
      if (opts.subtitle) {
        const subEl = document.createElement('p');
        subEl.className = 'fb-body';
        subEl.style.cssText = 'font-size: 0.8125rem; color: var(--fb-text-secondary); margin-top: 2px;';
        subEl.textContent = opts.subtitle;
        header.appendChild(subEl);
      }
      card.appendChild(header);
    }

    if (typeof innerContent === 'string') {
      const body = document.createElement('div');
      body.className = 'fb-card-body';
      body.innerHTML = innerContent;
      card.appendChild(body);
    } else if (innerContent && typeof innerContent === 'object') {
      if ('nodeType' in innerContent || 'tagName' in innerContent) {
        card.appendChild(innerContent);
      }
    }

    if (opts.onClick) {
      card.style.cursor = 'pointer';
      card.addEventListener('click', opts.onClick);
    }

    return card;
  }

  static renderStatCard(title, value, subtitle, iconSvg) {
    const card = document.createElement('div');
    card.className = 'fb-glass-card fb-stat-card';
    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
        <span class="fb-caption">${title}</span>
        ${iconSvg ? `<span style="color:var(--fb-accent-primary);">${iconSvg}</span>` : ''}
      </div>
      <div class="fb-h2" style="color:var(--fb-text-primary); font-weight:800;">${value}</div>
      ${subtitle ? `<div class="fb-body" style="font-size:0.75rem; color:var(--fb-text-muted); margin-top:4px;">${subtitle}</div>` : ''}
    `;
    return card;
  }
}
