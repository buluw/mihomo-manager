/* eslint-disable react-refresh/only-export-components */
import * as React from "react"

export type Theme = "dark" | "light" | "system"
export type ResolvedTheme = "dark" | "light"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
  legacyStorageKeys?: readonly string[]
  disableTransitionOnChange?: boolean
}

type ThemeProviderState = {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)"
const THEME_VALUES: Theme[] = ["dark", "light", "system"]
const EMPTY_STORAGE_KEYS: readonly string[] = []

const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(undefined)

function isTheme(value: string | null): value is Theme {
  if (value === null) return false
  return THEME_VALUES.includes(value as Theme)
}

function readStoredTheme(storageKey: string, legacyStorageKeys: readonly string[]) {
  const storedTheme = localStorage.getItem(storageKey)
  if (isTheme(storedTheme)) return storedTheme

  for (const legacyStorageKey of legacyStorageKeys) {
    const legacyTheme = localStorage.getItem(legacyStorageKey)
    if (isTheme(legacyTheme)) return legacyTheme
  }

  return null
}

export function getSystemTheme(): ResolvedTheme {
  return window.matchMedia(COLOR_SCHEME_QUERY).matches ? "dark" : "light"
}

export function faviconPath(theme: ResolvedTheme) {
  return theme === "dark" ? "/favicon-dark.svg" : "/favicon.svg"
}

function syncFavicon(theme: ResolvedTheme) {
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (icon) icon.href = faviconPath(theme)
}

function disableTransitionsTemporarily() {
  const style = document.createElement("style")
  style.appendChild(
    document.createTextNode(
      "*,*::before,*::after{-webkit-transition:none!important;transition:none!important}"
    )
  )
  document.head.appendChild(style)

  return () => {
    window.getComputedStyle(document.body)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => style.remove())
    })
  }
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "theme",
  legacyStorageKeys = EMPTY_STORAGE_KEYS,
  disableTransitionOnChange = true,
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(() => {
    return readStoredTheme(storageKey, legacyStorageKeys) ?? defaultTheme
  })
  const [resolvedTheme, setResolvedTheme] = React.useState<ResolvedTheme>(() =>
    theme === "system" ? getSystemTheme() : theme
  )

  React.useEffect(() => {
    if (isTheme(localStorage.getItem(storageKey))) return

    const legacyTheme = readStoredTheme(storageKey, legacyStorageKeys)
    if (legacyTheme) localStorage.setItem(storageKey, legacyTheme)
  }, [legacyStorageKeys, storageKey])

  const setTheme = React.useCallback(
    (nextTheme: Theme) => {
      localStorage.setItem(storageKey, nextTheme)
      setThemeState(nextTheme)
    },
    [storageKey]
  )

  const applyTheme = React.useCallback(
    (nextTheme: Theme) => {
      const root = document.documentElement
      const resolvedTheme = nextTheme === "system" ? getSystemTheme() : nextTheme
      const restoreTransitions = disableTransitionOnChange ? disableTransitionsTemporarily() : null

      root.classList.remove("light", "dark")
      root.classList.add(resolvedTheme)
      root.style.colorScheme = resolvedTheme
      setResolvedTheme(resolvedTheme)
      syncFavicon(resolvedTheme)
      restoreTransitions?.()
    },
    [disableTransitionOnChange]
  )

  React.useEffect(() => {
    applyTheme(theme)
    if (theme !== "system") return undefined

    const mediaQuery = window.matchMedia(COLOR_SCHEME_QUERY)
    const handleChange = () => applyTheme("system")
    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [theme, applyTheme])

  React.useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) return
      if (event.key === storageKey) {
        setThemeState(isTheme(event.newValue) ? event.newValue : defaultTheme)
        return
      }
      if (
        event.key &&
        legacyStorageKeys.includes(event.key) &&
        !isTheme(localStorage.getItem(storageKey)) &&
        isTheme(event.newValue)
      ) {
        localStorage.setItem(storageKey, event.newValue)
        setThemeState(event.newValue)
      }
    }

    window.addEventListener("storage", handleStorageChange)
    return () => window.removeEventListener("storage", handleStorageChange)
  }, [defaultTheme, legacyStorageKeys, storageKey])

  const value = React.useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [resolvedTheme, theme, setTheme]
  )

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export function useTheme() {
  const context = React.useContext(ThemeProviderContext)
  if (context === undefined) throw new Error("useTheme must be used within a ThemeProvider")
  return context
}
