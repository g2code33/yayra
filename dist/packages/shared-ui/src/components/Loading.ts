/**
 * FloatBrowse Component - Loading Indicators
 */

export class Loading {
  public static renderOrbSpinner(sizePx = 48): HTMLElement {
    const spinner = document.createElement('div');
    spinner.className = 'fb-orb-spinner';
    spinner.style.cssText = `
      width: ${sizePx}px; height: ${sizePx}px; border-radius: 50%;
      border: 3px solid rgba(255, 255, 255, 0.12);
      border-top-color: var(--fb-accent-primary);
      border-right-color: var(--fb-accent-secondary);
      animation: fbSpin 0.9s linear infinite;
    `;
    return spinner;
  }

  public static renderProgressBar(progressPercent = 0, indeterminate = false): { container: HTMLElement; setProgress: (p: number) => void } {
    const track = document.createElement('div');
    track.className = 'fb-progress-track';
    track.style.cssText = `
      width: 100%; height: 4px; background: rgba(255, 255, 255, 0.1);
      border-radius: 2px; overflow: hidden; position: relative;
    `;

    const bar = document.createElement('div');
    bar.className = 'fb-progress-bar';
    bar.style.cssText = `
      height: 100%; background: var(--fb-gradient-accent);
      border-radius: 2px; width: ${indeterminate ? '30%' : `${progressPercent}%`};
      transition: width 0.25s ease;
      ${indeterminate ? 'animation: fbIndeterminate 1.5s infinite ease-in-out;' : ''}
    `;

    track.appendChild(bar);

    const setProgress = (p: number) => {
      bar.style.width = `${Math.max(0, Math.min(100, p))}%`;
    };

    return { container: track, setProgress };
  }

  public static renderSkeletonCard(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'fb-glass-card fb-skeleton';
    card.style.cssText = 'height: 110px; opacity: 0.6;';
    return card;
  }
}
