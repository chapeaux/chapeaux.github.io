/**
 * <scheme-switcher> — Toggle between light, dark, and system color schemes.
 *
 * Sets `color-scheme` on <html> and persists the preference in localStorage.
 * Works with CSS `light-dark()` values — no class toggling needed.
 */
const SWITCHER_STYLES = `
scheme-switcher {
  display: flex;
  align-items: center;
}
.scheme-switcher {
  display: flex;
  gap: 2px;
  background: var(--gray-light, #e7e7e7);
  border-radius: 8px;
  padding: 3px;
}
.scheme-switcher button {
  all: unset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 20px;
  line-height: 1;
  transition: background 0.15s, transform 0.1s;
}
.scheme-switcher button:focus-visible {
  outline: 2px solid var(--cpx-blue, #0066cc);
  outline-offset: 1px;
}
.scheme-switcher button[aria-checked="true"] {
  background: var(--white, #fff);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.15);
  transform: scale(1.05);
}
.scheme-switcher button:hover:not([aria-checked="true"]) {
  background: rgb(255 255 255 / 0.5);
}
@media (max-width: 767px) {
  .scheme-switcher button {
    width: 32px;
    height: 32px;
    font-size: 18px;
  }
}
`;

let switcherStylesInjected = false;

class SchemeSwitcher extends HTMLElement {
  static STORAGE_KEY = 'scheme-preference';

  connectedCallback() {
    if (typeof window === 'undefined') return;

    if (!switcherStylesInjected) {
      const style = document.createElement('style');
      style.textContent = SWITCHER_STYLES;
      document.head.appendChild(style);
      switcherStylesInjected = true;
    }

    const stored = localStorage.getItem(SchemeSwitcher.STORAGE_KEY) || 'system';

    this.innerHTML = `
      <div class="scheme-switcher" role="radiogroup" aria-label="Color scheme">
        <button role="radio" aria-checked="false" aria-label="Light mode" data-scheme="light" title="Light">☀️</button>
        <button role="radio" aria-checked="false" aria-label="System default" data-scheme="system" title="System">💻</button>
        <button role="radio" aria-checked="false" aria-label="Dark mode" data-scheme="dark" title="Dark">🌙</button>
      </div>
    `;

    this.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => this._setScheme(btn.dataset.scheme));
    });

    this._setScheme(stored, false);
  }

  _setScheme(scheme, persist = true) {
    const root = document.documentElement;

    switch (scheme) {
      case 'light':
        root.style.colorScheme = 'light';
        break;
      case 'dark':
        root.style.colorScheme = 'dark';
        break;
      default:
        root.style.colorScheme = '';
        scheme = 'system';
        break;
    }

    this.querySelectorAll('button').forEach(btn => {
      btn.setAttribute('aria-checked', btn.dataset.scheme === scheme ? 'true' : 'false');
    });

    if (persist) {
      localStorage.setItem(SchemeSwitcher.STORAGE_KEY, scheme);
    }
  }
}

customElements.define('scheme-switcher', SchemeSwitcher);
