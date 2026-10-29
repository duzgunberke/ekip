const urlLanguage = new URLSearchParams(window.location.search).get('lang')
let language: 'en' | 'tr' | null =
  urlLanguage === 'en' || urlLanguage === 'tr' ? urlLanguage : null

if (!language) {
  try {
    const stored = window.localStorage.getItem('ekip-lang')
    if (stored === 'en' || stored === 'tr') language = stored
  } catch {
    // Continue with the browser language when storage is disabled.
  }
}

language ??= navigator.language.toLowerCase().startsWith('tr') ? 'tr' : 'en'
document.documentElement.lang = language
document.title = language === 'tr' ? 'ekip · iş kontrol paneli' : 'ekip · work control panel'
