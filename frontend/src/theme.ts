import { EventBus } from './events';
import { EVENTS } from './event-names';
import { span, traceNextPaint } from './perf-trace';

type ThemePreference = 'light' | 'dark' | 'system';

export class ThemeManager {
  private preference: ThemePreference;
  private currentTheme: 'light' | 'dark';
  private bus: EventBus;

  constructor(bus: EventBus, configTheme: string) {
    this.bus = bus;
    this.preference = (configTheme === 'system' || configTheme === 'light' || configTheme === 'dark')
      ? configTheme as ThemePreference
      : 'system';
    this.currentTheme = this.preference === 'system'
      ? this.detectSystem()
      : this.preference;
    this.apply();

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (this.preference === 'system') {
        this.currentTheme = e.matches ? 'dark' : 'light';
        this.apply();
      }
    });
  }

  private detectSystem(): 'light' | 'dark' {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  private apply(): void {
    const end = span('theme-apply', this.currentTheme);
    document.documentElement.dataset.theme = this.currentTheme;
    this.bus.emit(EVENTS.THEME_CHANGED, {
      theme: this.currentTheme,
      preference: this.preference,
    });
    end();
    traceNextPaint('theme-switch', document.body);
  }

  /** Ease surfaces between palettes on an explicit switch (see themes.css). */
  private transitionSmoothly(): void {
    const root = document.documentElement;
    root.classList.add('theme-transition');
    window.setTimeout(() => root.classList.remove('theme-transition'), 220);
  }

  toggle(): void {
    this.transitionSmoothly();
    if (this.preference === 'system') {
      // First toggle out of system: switch to the opposite of the current
      this.currentTheme = this.currentTheme === 'light' ? 'dark' : 'light';
      this.preference = this.currentTheme;
    } else if (this.preference === 'light') {
      this.preference = 'dark';
      this.currentTheme = 'dark';
    } else {
      // dark → system (completes the cycle: system → light → dark → system)
      this.preference = 'system';
      this.currentTheme = this.detectSystem();
    }
    this.apply();
  }

  getTheme(): ThemePreference {
    return this.preference;
  }
}
