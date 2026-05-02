type Locale = "en" | "es" | "fr" | "pt-BR";
type Params = Record<string, string | number>;

const translations: Record<Exclude<Locale, "en">, Record<string, string>> = {
	es: {
		"ask.error.noUi": "Error: la interfaz no está disponible (modo no interactivo)",
	},
	fr: {
		"ask.error.noUi": "Erreur : l’interface n’est pas disponible (mode non interactif)",
	},
	"pt-BR": {
		"ask.error.noUi": "Erro: UI indisponível (executando em modo não interativo)",
	},
};

let currentLocale: Locale = "en";

export function initI18n(pi: { events?: { emit?: (event: string, payload: unknown) => void } }): void {
	pi.events?.emit?.("pi-core/i18n/registerBundle", {
		namespace: "rpiv-ask-user-question",
		defaultLocale: "en",
		locales: translations,
	});
	pi.events?.emit?.("pi-core/i18n/requestApi", {
		onReady: (api: { getLocale?: () => string; onLocaleChange?: (cb: (locale: string) => void) => void }) => {
			const locale = api.getLocale?.();
			if (isLocale(locale)) currentLocale = locale;
			api.onLocaleChange?.((next) => {
				if (isLocale(next)) currentLocale = next;
			});
		},
	});
}

export function t(key: string, fallback: string, params: Params = {}): string {
	const template = currentLocale === "en" ? fallback : translations[currentLocale]?.[key] ?? fallback;
	return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}

function isLocale(locale: string | undefined): locale is Locale {
	return locale === "en" || locale === "es" || locale === "fr" || locale === "pt-BR";
}
