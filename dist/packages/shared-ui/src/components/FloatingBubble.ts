/**
 * FloatBrowse Component - FloatingBubble
 * High-fidelity glass orb visual component reflecting real platform service state.
 */

import { Icons } from '../icons/icons.js';

export interface FloatingBubbleOptions {
  sizePx?: number;
  isActive?: boolean;
  badgeCount?: number;
  onClick?: (e: MouseEvent) => void;
  showPulse?: boolean;
}

export interface Position2D {
  x: number;
  y: number;
}

export class FloatingBubble {
  public static render(options: FloatingBubbleOptions = {}): HTMLElement {
    const size = options.sizePx || 58;
    const bubble = document.createElement('div');
    bubble.className = 'fb-orb fb-floating-bubble';
    bubble.style.cssText = `
      width: ${size}px; height: ${size}px; position: relative;
    `;

    bubble.innerHTML = `
      ${options.showPulse || options.isActive ? '<div class="fb-orb-pulse"></div>' : ''}
      <div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; pointer-events:none;">
        ${Icons.logoOrb}
      </div>
      ${options.badgeCount && options.badgeCount > 0 ? `
        <span class="fb-badge fb-badge-cyan" style="position:absolute; top:-4px; right:-4px; min-width:18px; height:18px; padding:0 4px; font-size:10px; border-radius:9px;">
          ${options.badgeCount}
        </span>
      ` : ''}
    `;

    if (options.onClick) {
      bubble.addEventListener('click', options.onClick);
    }

    return bubble;
  }

  public static calculateSnapPosition(
    currentPos: Position2D,
    bubbleSize: number,
    screenWidth: number,
    screenHeight: number,
    padding = 12
  ): Position2D {
    const midX = screenWidth / 2;
    const snapX = currentPos.x + bubbleSize / 2 < midX ? padding : screenWidth - bubbleSize - padding;
    const clampedY = Math.max(padding, Math.min(screenHeight - bubbleSize - padding, currentPos.y));
    return { x: snapX, y: clampedY };
  }

  public static calculateSnap(
    currentPos: Position2D,
    bubbleSize: number,
    screenWidth: number,
    screenHeight: number,
    padding = 12
  ): Position2D {
    return this.calculateSnapPosition(currentPos, bubbleSize, screenWidth, screenHeight, padding);
  }
}
