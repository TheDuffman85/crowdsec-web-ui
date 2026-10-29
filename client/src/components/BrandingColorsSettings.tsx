import { useState, type CSSProperties } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_BRANDING_THEME,
  MIN_ACCENT_CONTRAST,
  NEUTRAL_TONES,
  THEME_MODES,
  THEME_SHADES,
  getAccentContrast,
  getResolvedThemeModeVariables,
  isDefaultBrandingTheme,
  normalizeHexColor,
  resolveThemeMode,
  type BrandingTheme,
  type NeutralTone,
  type ThemeModeColors,
  type ThemeModeName,
} from "../../../shared/branding-theme";
import { useI18n } from "../lib/i18n";

interface BrandingColorsSettingsProps {
  theme: BrandingTheme;
  onChange: (theme: BrandingTheme) => void;
  disabled: boolean;
  inputClass: string;
  labelClass: string;
}

const secondaryButtonClass = "inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800";

/**
 * Previews a mode with explicit (non-`dark:`) classes and every color variable
 * set inline, so it shows the draft regardless of the theme currently active.
 */
function ThemePreview({ theme, mode }: { theme: BrandingTheme; mode: ThemeModeName }) {
  const { t } = useI18n();
  const style = getResolvedThemeModeVariables(theme, mode) as CSSProperties;
  const dark = mode === "dark";

  return (
    <div
      style={style}
      data-testid={`settings-theme-preview-${mode}`}
      className={`space-y-3 rounded-lg border p-3 ${dark ? "border-gray-800 bg-gray-950" : "border-gray-200 bg-gray-50"}`}
    >
      <div className={`rounded-md border p-3 ${dark ? "border-gray-800 bg-gray-900" : "border-gray-200 bg-white"}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={`text-sm font-semibold ${dark ? "text-gray-100" : "text-gray-900"}`}>
            {t("pages.settings.themePreviewTitle")}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${dark ? "bg-primary-900/40 text-primary-300" : "bg-primary-50 text-primary-700"}`}>
            {t("pages.settings.themePreviewBadge")}
          </span>
        </div>
        <p className={`mt-1 text-xs ${dark ? "text-gray-400" : "text-gray-500"}`}>{t("pages.settings.themePreviewText")}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="inline-flex h-8 items-center rounded-lg bg-primary-600 px-3 text-xs font-medium text-white">
            {t("pages.settings.themePreviewButton")}
          </span>
          <span className={`text-xs font-medium ${dark ? "text-primary-400" : "text-primary-600"}`}>{t("pages.settings.themePreviewLink")}</span>
        </div>
      </div>
      <div className="flex overflow-hidden rounded-md" aria-hidden="true">
        {THEME_SHADES.map((shade) => (
          <span key={shade} className="h-4 flex-1" style={{ backgroundColor: `var(--color-primary-${shade})` }} />
        ))}
      </div>
    </div>
  );
}

// Edits the theme draft; the Settings page saves it together with the other branding settings.
export function BrandingColorsSettings({
  theme,
  onChange,
  disabled,
  inputClass,
  labelClass,
}: BrandingColorsSettingsProps) {
  const { t } = useI18n();
  const [hexDrafts, setHexDrafts] = useState<Partial<Record<ThemeModeName, string>>>({});

  const updateMode = (mode: ThemeModeName, colors: Partial<ThemeModeColors>) => {
    onChange({ ...theme, [mode]: { ...theme[mode], ...colors } });
  };

  const handleHexChange = (mode: ThemeModeName, value: string) => {
    setHexDrafts((drafts) => ({ ...drafts, [mode]: value }));
    if (!value.trim()) {
      updateMode(mode, { accent: null });
      return;
    }
    const accent = normalizeHexColor(value);
    if (accent) updateMode(mode, { accent });
  };

  const clearHexDraft = (mode: ThemeModeName) => {
    setHexDrafts((drafts) => {
      const next = { ...drafts };
      delete next[mode];
      return next;
    });
  };

  const handleRestoreDefaults = () => {
    onChange(DEFAULT_BRANDING_THEME);
    setHexDrafts({});
  };

  return (
    <div className="mt-8 border-t border-gray-200 pt-6 dark:border-gray-700">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t("pages.settings.colors")}</h3>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("pages.settings.colorsDescription")}</p>

      <div className="mt-4 grid gap-6 xl:grid-cols-2">
        {THEME_MODES.map((mode) => {
          const colors = theme[mode];
          const resolved = resolveThemeMode(theme, mode);
          const pickerValue = colors.accent ?? resolved.accent ?? DEFAULT_ACCENT_COLOR;
          const inheritsLight = mode === "dark";
          const contrast = getAccentContrast(theme, mode);
          const minContrast = contrast ? Math.min(contrast.buttonText, contrast.accentText) : null;
          const accentId = `settings-theme-${mode}-accent`;
          const neutralId = `settings-theme-${mode}-neutral`;

          return (
            <div key={mode} className="space-y-4" data-testid={`settings-theme-${mode}`}>
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t(mode === "light" ? "pages.settings.lightMode" : "pages.settings.darkMode")}
              </h4>

              <div className="space-y-2">
                <label htmlFor={accentId} className={labelClass}>
                  {t("pages.settings.accentColor")}
                </label>
                <div className="flex gap-2">
                  <input
                    type="color"
                    value={pickerValue}
                    onChange={(event) => {
                      clearHexDraft(mode);
                      updateMode(mode, { accent: event.target.value.toLowerCase() });
                    }}
                    disabled={disabled}
                    aria-label={t("pages.settings.accentColorPicker", { mode: t(mode === "light" ? "pages.settings.lightMode" : "pages.settings.darkMode") })}
                    className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-gray-300 bg-white p-1 disabled:cursor-not-allowed dark:border-gray-700 dark:bg-gray-900"
                  />
                  <input
                    id={accentId}
                    type="text"
                    value={hexDrafts[mode] ?? colors.accent ?? ""}
                    placeholder={inheritsLight && theme.light.accent
                      ? t("pages.settings.sameAsLightMode")
                      : t("pages.settings.defaultColor", { color: DEFAULT_ACCENT_COLOR })}
                    maxLength={7}
                    spellCheck={false}
                    onChange={(event) => handleHexChange(mode, event.target.value)}
                    onBlur={() => clearHexDraft(mode)}
                    disabled={disabled}
                    className={`${inputClass} font-mono`}
                  />
                  {colors.accent && (
                    <button
                      type="button"
                      onClick={() => {
                        clearHexDraft(mode);
                        updateMode(mode, { accent: null });
                      }}
                      disabled={disabled}
                      aria-label={t(inheritsLight ? "pages.settings.useLightModeAccent" : "pages.settings.useDefaultAccent")}
                      title={t(inheritsLight ? "pages.settings.useLightModeAccent" : "pages.settings.useDefaultAccent")}
                      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      <RotateCcw className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t(inheritsLight ? "pages.settings.darkAccentHelp" : "pages.settings.accentHelp")}
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor={neutralId} className={labelClass}>
                  {t("pages.settings.neutralTone")}
                </label>
                <select
                  id={neutralId}
                  value={colors.neutral ?? ""}
                  onChange={(event) => updateMode(mode, { neutral: (event.target.value || null) as NeutralTone | null })}
                  disabled={disabled}
                  className={inputClass}
                >
                  <option value="">
                    {inheritsLight
                      ? t("pages.settings.sameAsLightMode")
                      : t("pages.settings.defaultNeutralTone", { tone: t("pages.settings.neutralTones.gray") })}
                  </option>
                  {NEUTRAL_TONES.map((tone) => (
                    <option key={tone} value={tone}>{t(`pages.settings.neutralTones.${tone}`)}</option>
                  ))}
                </select>
              </div>

              <ThemePreview theme={theme} mode={mode} />

              {minContrast !== null && minContrast < MIN_ACCENT_CONTRAST && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{t("pages.settings.lowAccentContrast", { ratio: minContrast.toFixed(1) })}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleRestoreDefaults}
          disabled={disabled || isDefaultBrandingTheme(theme)}
          className={secondaryButtonClass}
        >
          <RotateCcw className="h-4 w-4" />
          {t("pages.settings.restoreDefaultColors")}
        </button>
      </div>
    </div>
  );
}
