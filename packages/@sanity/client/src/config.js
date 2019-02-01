const generateHelpUrl = require('@sanity/generate-help-url')
const assign = require('object-assign')
const validate = require('./validators')
const warnings = require('./warnings')

const defaultCdnHost = 'apicdn.sanity.io'
const defaultConfig = {
  apiHost: 'https://api.sanity.io',
  apiVersion: '1',
  useProjectHostname: true,
  gradientMode: false,
  isPromiseAPI: true
}

const LOCALHOSTS = ['localhost', '127.0.0.1', '0.0.0.0']
const isLocal = host => LOCALHOSTS.indexOf(host) !== -1

exports.defaultConfig = defaultConfig

// eslint-disable-next-line complexity
exports.initConfig = (config, prevConfig) => {
  const specifiedConfig = assign({}, prevConfig, config)
  if (!specifiedConfig.apiVersion) {
    warnings.printNoApiVersionSpecifiedWarning()
  }

  const newConfig = assign({}, defaultConfig, specifiedConfig)
  const gradientMode = newConfig.gradientMode
  const projectBased = !gradientMode && newConfig.useProjectHostname

  if (typeof Promise === 'undefined') {
    const helpUrl = generateHelpUrl('js-client-promise-polyfill')
    throw new Error(`No native Promise-implementation found, polyfill needed - see ${helpUrl}`)
  }

  if (gradientMode && !newConfig.namespace) {
    throw new Error('Configuration must contain `namespace` when running in gradient mode')
  }

  if (projectBased && !newConfig.projectId) {
    throw new Error('Configuration must contain `projectId`')
  }

  const isBrowser = typeof window !== 'undefined' && window.location && window.location.hostname
  const isLocalhost = isBrowser && isLocal(window.location.hostname)

  if (isBrowser && isLocalhost && newConfig.token && newConfig.ignoreBrowserTokenWarning !== true) {
    warnings.printBrowserTokenWarning()
  } else if ((!isBrowser || isLocalhost) && newConfig.useCdn && newConfig.token) {
    warnings.printCdnTokenWarning()
  } else if (typeof newConfig.useCdn === 'undefined') {
    warnings.printCdnWarning()
  }

  if (projectBased) {
    validate.projectId(newConfig.projectId)
  }

  if (!gradientMode && newConfig.dataset) {
    validate.dataset(newConfig.dataset, newConfig.gradientMode)
  }

  newConfig.apiVersion = `${newConfig.apiVersion}`.replace(/^v/, '')
  newConfig.isDefaultApi = newConfig.apiHost === defaultConfig.apiHost
  newConfig.useCdn = Boolean(newConfig.useCdn) && !newConfig.token && !newConfig.withCredentials

  exports.validateApiVersion(newConfig.apiVersion)

  if (newConfig.gradientMode) {
    newConfig.url = newConfig.apiHost
    newConfig.cdnUrl = newConfig.apiHost
  } else {
    const hostParts = newConfig.apiHost.split('://', 2)
    const protocol = hostParts[0]
    const host = hostParts[1]
    const cdnHost = newConfig.isDefaultApi ? defaultCdnHost : host

    if (newConfig.useProjectHostname) {
      newConfig.url = `${protocol}://${newConfig.projectId}.${host}/v${newConfig.apiVersion}`
      newConfig.cdnUrl = `${protocol}://${newConfig.projectId}.${cdnHost}/v${newConfig.apiVersion}`
    } else {
      newConfig.url = `${newConfig.apiHost}/v${newConfig.apiVersion}`
      newConfig.cdnUrl = newConfig.url
    }
  }

  return newConfig
}

exports.validateApiVersion = function validateApiVersion(apiVersion, nowOffset = 0) {
  if (apiVersion === '1' || apiVersion === 'X') {
    return
  }

  const apiDate = new Date(apiVersion)
  const apiVersionValid =
    /^\d{4}-\d{2}-\d{2}$/.test(apiVersion) && apiDate instanceof Date && apiDate.getTime() > 0

  if (!apiVersionValid) {
    throw new Error('Invalid API version string, expected `1` or date in format `YYYY-MM-DD`')
  }

  const today = new Date(Date.now() + nowOffset)
  const tomorrow = new Date(Date.now() + nowOffset)
  tomorrow.setDate(today.getDate() + 1)

  const todayUtc = getUtcDate(today)
  const tomorrowUtc = getUtcDate(tomorrow)

  if (apiVersion === tomorrowUtc) {
    // The date specified is actually "tomorrow" in UTC terms, which is _allowed_,
    // but might suddenly change behavior. Warn that the user probably wants to use
    // todays UTC date, unless she means to use a hotfix (just released) version
    warnings.printApiVersionNextDayWarning(today, todayUtc, apiVersion, todayUtc)
  } else if (apiDate > tomorrow) {
    // The date specified is in the future, which the API will reject. Since you will
    // not be able to use the API for anything, throwing is the only logical choice
    throw new Error(
      [
        'You have set an API version that is in the future! -',
        `according to your system clock, today is ${todayUtc} in Coordinated Universal Time.`,
        `You specified ${apiVersion}, which could introduce breaking changes given the date is`,
        `in the future. You probably want to use todays UTC date instead (${todayUtc}).`
      ].join(' ')
    )
  }
}

function getUtcDate(date) {
  return `${date.getUTCFullYear()}-${padDate(date.getUTCMonth() + 1)}-${padDate(date.getUTCDate())}`
}

function padDate(date) {
  return date < 10 ? `0${date}` : `${date}`
}
