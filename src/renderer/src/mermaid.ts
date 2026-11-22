// Mermaid diagrams: Marky's own colours, and re-rendering when the theme changes.
//
// Vditor renders ```mermaid blocks itself: it loads mermaid.min.js the first time a diagram
// appears, then calls mermaid.initialize() before every render with Mermaid's stock themes (a
// drab grey "dark", where pie slices come out nearly black, and a purple "default"), and with
// numbered arrows forced on in every sequence diagram. Marky wraps initialize() as soon as the
// script defines `window.mermaid` and swaps in its own theme.
import Vditor from 'vditor'

type Config = Record<string, unknown> & { theme?: string; sequence?: Record<string, unknown> }
interface Mermaid {
  initialize(config: Config): void
}

const LIGHT = {
  darkMode: false,
  background: '#ffffff',
  primaryColor: '#eaf1ff',
  primaryBorderColor: '#7aa2f7',
  primaryTextColor: '#1f2328',
  secondaryColor: '#eaf6ee',
  secondaryBorderColor: '#7cc192',
  tertiaryColor: '#f6f8fa',
  tertiaryBorderColor: '#d0d7de',
  lineColor: '#6e7781',
  textColor: '#1f2328',
  titleColor: '#1f2328',
  edgeLabelBackground: '#ffffff',
  clusterBkg: '#f6f8fa',
  clusterBorder: '#d0d7de',
  noteBkgColor: '#fff8c5',
  noteBorderColor: '#e3c46c',
  noteTextColor: '#1f2328',
  pieStrokeColor: '#ffffff',
  pieOuterStrokeColor: '#ffffff',
  pieSectionTextColor: '#ffffff',
  pieTitleTextColor: '#1f2328',
  pieLegendTextColor: '#1f2328',
  pieOpacity: '1',
  ...pieColors(['#3d7eff', '#2da44e', '#c4931f', '#e5534b', '#8250df', '#1b9aaa', '#e0823d', '#6e7781']),
  // Gantt charts
  taskBkgColor: '#d6e4ff',
  taskBorderColor: '#7aa2f7',
  activeTaskBkgColor: '#a8c5ff',
  activeTaskBorderColor: '#3d7eff',
  doneTaskBkgColor: '#e1e4e8',
  doneTaskBorderColor: '#afb8c1',
  critBkgColor: '#ffd7d5',
  critBorderColor: '#e5534b',
  taskTextColor: '#1f2328',
  taskTextDarkColor: '#1f2328',
  taskTextLightColor: '#1f2328',
  taskTextOutsideColor: '#1f2328',
  sectionBkgColor: '#f6f8fa',
  sectionBkgColor2: '#f6f8fa',
  altSectionBkgColor: '#ffffff',
  gridColor: '#e1e4e8',
  todayLineColor: '#e5534b'
}

const DARK = {
  darkMode: true,
  background: '#1e1f22',
  primaryColor: '#1f2b40',
  primaryBorderColor: '#5b93ff',
  primaryTextColor: '#e6e8eb',
  secondaryColor: '#1e3326',
  secondaryBorderColor: '#3fb950',
  tertiaryColor: '#26282b',
  tertiaryBorderColor: '#3a3d42',
  lineColor: '#8b929b',
  textColor: '#d7dadf',
  titleColor: '#d7dadf',
  edgeLabelBackground: '#1e1f22',
  clusterBkg: '#24262a',
  clusterBorder: '#3a3d42',
  noteBkgColor: '#3a3320',
  noteBorderColor: '#8a7330',
  noteTextColor: '#e6e8eb',
  sequenceNumberColor: '#1e1f22', // on light circles
  pieStrokeColor: '#1e1f22',
  pieOuterStrokeColor: '#1e1f22',
  pieSectionTextColor: '#ffffff',
  pieTitleTextColor: '#d7dadf',
  pieLegendTextColor: '#d7dadf',
  pieOpacity: '1',
  ...pieColors(['#4c86f0', '#2f9e4a', '#b8892a', '#d9534f', '#8a63d2', '#2a9aa8', '#d0793a', '#6e7781']),
  // Gantt charts
  taskBkgColor: '#1f2b40',
  taskBorderColor: '#5b93ff',
  activeTaskBkgColor: '#2d4a7a',
  activeTaskBorderColor: '#7aa7ff',
  doneTaskBkgColor: '#2d3036',
  doneTaskBorderColor: '#555b63',
  critBkgColor: '#4a2023',
  critBorderColor: '#f47067',
  taskTextColor: '#e6e8eb',
  taskTextDarkColor: '#e6e8eb',
  taskTextLightColor: '#e6e8eb',
  taskTextOutsideColor: '#d7dadf',
  sectionBkgColor: '#24262a',
  sectionBkgColor2: '#24262a',
  altSectionBkgColor: '#1e1f22',
  gridColor: '#3a3d42',
  todayLineColor: '#f47067'
}

function pieColors(colors: string[]): Record<string, string> {
  return Object.fromEntries(colors.map((c, i) => [`pie${i + 1}`, c]))
}

/** Marky's settings for Vditor's mermaid.initialize() call. Vditor passes theme "dark" in dark mode. */
function withMarkyTheme(config: Config): Config {
  const font = getComputedStyle(document.documentElement).getPropertyValue('--font-family').trim() || 'sans-serif'
  return {
    ...config,
    theme: 'base', // the only theme Mermaid lets you recolour
    fontFamily: font,
    themeVariables: { ...(config.theme === 'dark' ? DARK : LIGHT), fontFamily: font },
    // Numbered arrows only when a diagram asks for them (`autonumber`), as in Mermaid itself.
    sequence: { ...config.sequence, showSequenceNumbers: false }
  }
}

/** Call once at startup, before any editor is created. */
export function installMermaidTheme(): void {
  let mermaid: Mermaid | undefined
  // mermaid.min.js ends with `globalThis["mermaid"] = ...`.
  Object.defineProperty(window, 'mermaid', {
    configurable: true,
    get: () => mermaid,
    set: (m: Mermaid) => {
      const initialize = m.initialize.bind(m)
      m.initialize = (config) => initialize(withMarkyTheme(config))
      mermaid = m
    }
  })
}

/**
 * Renders the diagrams in `container` again, e.g. after switching between light and dark (the
 * colours are baked into each diagram). `cdn` and `theme` are what the editor was created with.
 */
export function rerenderDiagrams(container: HTMLElement, cdn: string, theme: string): void {
  for (const el of container.querySelectorAll<HTMLElement>('.vditor-ir__preview > .language-mermaid[data-processed]')) {
    const source = el.closest('[data-type="code-block"]')?.querySelector('.vditor-ir__marker--pre > code')?.textContent
    if (source == null) continue
    el.removeAttribute('data-processed')
    el.textContent = source
    // Only this preview: the source <code> next to it has the same language-mermaid class.
    Vditor.mermaidRender(el.parentElement!, cdn, theme)
  }
}
