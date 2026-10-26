const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const read = path => readFileSync(resolve(__dirname, '..', path), 'utf8');
const css = read('assets/styles.css');
const properties = block => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)]
  .map(([, key, value]) => [key, value.trim()]));
const base = properties(css.match(/:root\s*\{([^}]+)\}/)[1]);
const dark = properties(css.match(/html\.dark-theme,\s*body\.dark-theme\s*\{([^}]+)\}/)[1]);
const light = properties(css.match(/html\.light-theme,\s*body\.light-theme\s*\{([^}]+)\}/)[1]);

function luminance(hex) {
  const full = hex.slice(1).replace(/^(\w)(\w)(\w)$/, '$1$1$2$2$3$3');
  const [r, g, b] = full.match(/\w\w/g).map(channel => parseInt(channel, 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('automatic and explicit dark themes share the warm palette and light resets every theme token', () => {
  const automatic = properties(css.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]+)\}/)[1]);
  assert.deepEqual(automatic, dark);
  for (const key of Object.keys(dark)) assert.equal(light[key], base[key], `light theme resets ${key}`);
  assert.equal(light.bg, '#f5f0e8');
  assert.equal(light.text, '#3a3a3a');
  assert.equal(light.accent, '#3b82f6');
  for (const key of ['bg', 'surface', 'card', 'text', 'muted', 'border', 'accent']) {
    const [r, g, b] = dark[key].slice(1).match(/\w\w/g).map(channel => parseInt(channel, 16));
    assert.ok(r >= g && g >= b, `${key} uses a warm rather than blue-grey tint`);
  }
  assert.ok(luminance(dark['selected-bg']) < 0.1, 'selected tabs do not use a bright text-colored fill');
});

test('warm dark text, highlights and destructive buttons retain readable contrast', () => {
  for (const background of ['bg', 'surface', 'card']) {
    for (const foreground of ['text', 'muted', 'accent']) {
      assert.ok(contrast(dark[foreground], dark[background]) >= 4.5, `${foreground} on ${background}`);
    }
  }
  for (const [foreground, background] of [
    ['on-accent', 'accent'], ['selected-text', 'selected-bg'],
    ['on-danger', 'danger'], ['on-danger', 'danger-hover']
  ]) {
    assert.ok(contrast(dark[foreground], dark[background]) >= 4.5, `${foreground} on ${background}`);
  }
  assert.ok(contrast(dark['switch-thumb'], dark['switch-active']) >= 3);
});

for (const page of ['index.html', 'lesson.html', 'favorites.html']) {
  test(`${page} uses the warm background before CSS loads and preserves theme switching`, () => {
    const scripts = [...read(page).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    const firstPaint = scripts.find(script => script.includes('root.style.colorScheme = theme') && !script.includes('THEME_KEY'));
    const themeScript = scripts.find(script => script.includes('const THEME_KEY'));
    for (const saved of [null, 'light', 'dark']) {
      for (const systemDark of [false, true]) {
        const element = () => ({
          style: {},
          classList: {
            values: new Set(),
            add(value) { this.values.add(value); },
            remove(...values) { values.forEach(value => this.values.delete(value)); },
            contains(value) { return this.values.has(value); }
          }
        });
        const root = element();
        const body = element();
        const handlers = {};
        const button = { addEventListener(type, handler) { handlers[type] = handler; }, setAttribute() {} };
        const values = new Map(saved ? [['nce_theme', saved]] : []);
        const context = vm.createContext({
          document: {
            documentElement: root, body, readyState: 'complete',
            getElementById: () => button
          },
          localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
          matchMedia: () => ({ matches: systemDark, addEventListener() {} }),
          getComputedStyle: () => ({ getPropertyValue: () => '' }),
          requestAnimationFrame() {}
        });
        context.window = context;
        const expectedTheme = saved || (systemDark ? 'dark' : 'light');
        const expectedBackground = expectedTheme === 'dark' ? dark.bg : light.bg;
        vm.runInContext(firstPaint, context);
        assert.equal(root.style.backgroundColor, expectedBackground);
        assert.equal(root.style.colorScheme, expectedTheme);
        vm.runInContext(themeScript, context);
        assert.equal(body.style.backgroundColor, expectedBackground);
        handlers.click();
        const next = expectedTheme === 'dark' ? 'light' : 'dark';
        assert.equal(values.get('nce_theme'), next);
        assert.equal(root.style.colorScheme, next);
        assert.equal(root.style.backgroundColor, next === 'dark' ? dark.bg : light.bg);
        assert.equal(body.style.backgroundColor, root.style.backgroundColor);
        assert.equal(root.classList.contains(`${expectedTheme}-theme`), false);
        assert.equal(body.classList.contains(`${next}-theme`), true);
      }
    }
  });
}
