/**
 * Yayra Floating Browser - Floating Circle Component
 */

export class FloatingCircleComponent {
  constructor(controller, eventBus) {
    this.controller = controller;
    this.eventBus = eventBus;
    this.element = null;
    this.isPointerDown = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.initialCircleX = 0;
    this.initialCircleY = 0;
    this.hasMoved = false;
  }

  render(container = document.body) {
    const state = this.controller.getState();
    const circle = document.createElement('div');
    circle.className = 'yayra-glass-surface yayra-floating-circle';
    circle.id = 'yayra-floating-circle';
    circle.setAttribute('role', 'button');
    circle.setAttribute('aria-label', 'Yayra Floating Browser Bubble');
    circle.tabIndex = 0;

    circle.style.left = `${state.x}px`;
    circle.style.top = `${state.y}px`;
    circle.style.display = state.isVisible ? 'flex' : 'none';

    circle.innerHTML = `
      <svg class="yayra-circle-icon" viewBox="0 0 24 24">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
      </svg>
      ${state.badgeCount > 0 ? `<span class="yayra-circle-badge">${state.badgeCount}</span>` : ''}
    `;

    this.attachEvents(circle);
    container.appendChild(circle);
    this.element = circle;

    return circle;
  }

  attachEvents(el) {
    el.addEventListener('pointerdown', (e) => {
      this.isPointerDown = true;
      this.hasMoved = false;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      const state = this.controller.getState();
      this.initialCircleX = state.x;
      this.initialCircleY = state.y;
      if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (!this.isPointerDown) return;
      const dx = e.clientX - this.dragStartX;
      const dy = e.clientY - this.dragStartY;

      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        this.hasMoved = true;
      }

      const newX = this.initialCircleX + dx;
      const newY = this.initialCircleY + dy;
      this.controller.setPosition(newX, newY);

      el.style.left = `${newX}px`;
      el.style.top = `${newY}px`;
    });

    const onPointerUp = (e) => {
      if (!this.isPointerDown) return;
      this.isPointerDown = false;
      if (el.releasePointerCapture) el.releasePointerCapture(e.pointerId);

      if (!this.hasMoved) {
        this.controller.toggleExpand();
      } else {
        const screenW = typeof window !== 'undefined' ? window.innerWidth : 800;
        const screenH = typeof window !== 'undefined' ? window.innerHeight : 600;
        this.controller.snapToNearestEdge(screenW, screenH);
        const snapped = this.controller.getState();
        el.style.left = `${snapped.x}px`;
        el.style.top = `${snapped.y}px`;
      }
    };

    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.controller.toggleExpand();
      }
    });
  }

  updateVisibility(visible) {
    if (this.element) {
      this.element.style.display = visible ? 'flex' : 'none';
    }
  }

  destroy() {
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
      this.element = null;
    }
  }
}
