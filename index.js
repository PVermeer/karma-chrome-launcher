/* eslint-disable space-before-function-paren */
var fs = require('fs')
var path = require('path')
var which = require('which')
const isWsl = require('is-wsl')
const { spawn, exec, execSync } = require('child_process')
const { StringDecoder } = require('string_decoder')

function isJSFlags(flag) {
  return flag.indexOf('--js-flags=') === 0
}

function sanitizeJSFlags(flag) {
  var test = /--js-flags=(['"])/.exec(flag)
  if (!test) {
    return flag
  }
  var escapeChar = test[1]
  var endExp = new RegExp(escapeChar + '$')
  var startExp = new RegExp('--js-flags=' + escapeChar)
  return flag.replace(startExp, '--js-flags=').replace(endExp, '')
}

var ChromeBrowser = function (baseBrowserDecorator, args) {
  baseBrowserDecorator(this)
  let windowsUsed = false
  let browserProcessPid

  var flags = args.flags || []
  var userDataDir = args.chromeDataDir || this._tempDir

  this._getOptions = function () {
    // Chrome CLI options
    // http://peter.sh/experiments/chromium-command-line-switches/
    flags.forEach(function (flag, i) {
      if (isJSFlags(flag)) {
        flags[i] = sanitizeJSFlags(flag)
      }
    })

    return [
      '--user-data-dir=' + userDataDir,
      // https://github.com/GoogleChrome/chrome-launcher/blob/master/docs/chrome-flags-for-tools.md#--enable-automation
      '--enable-automation',
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-default-apps',
      '--disable-popup-blocking',
      '--disable-translate',
      '--disable-background-timer-throttling',
      // on macOS, disable-background-timer-throttling is not enough
      // and we need disable-renderer-backgrounding too
      // see https://github.com/karma-runner/karma-chrome-launcher/issues/123
      '--disable-renderer-backgrounding',
      '--disable-device-discovery-notifications'
    ].concat(flags)
  }

  this._start = (url) => {
    var command = this._getCommand()
    let runningProcess

    const useWindowsWSL = () => {
      console.log('WSL: using Windows')
      command = this.DEFAULT_CMD.win32
      windowsUsed = true

      const translatedUserDataDir = execSync('wslpath -w ' + userDataDir).toString().trim()

      // Translate command to a windows path to make it possisible to get the pid.
      let commandPrepare = this.DEFAULT_CMD.win32.split('/')
      const executable = commandPrepare.pop()
      commandPrepare = commandPrepare.join('/')
        .replace(/\s/g, '\\ ')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
      const commandTranslatePath = execSync('wslpath -w ' + commandPrepare).toString().trim()
      const commandTranslated = commandTranslatePath + '\\' + executable

      /*
      Custom launch implementation to get pid via wsl interop:
      Start chrome on windows and send process id back via stderr (mozilla strategy).
      */
      this._execCommand = spawn('/bin/bash', ['-c',
        `
        processString=$(wmic.exe process call create "${commandTranslated}\
        ${url}\
        --user-data-dir=${translatedUserDataDir}\
        ${this._getOptions().join(' ')}\
        ");

        while IFS= read -r line; do
          if [[ $line == *"ProcessId = "* ]]; then
      
            removePrefix=\${line#*ProcessId = }
            removeSuffix=\${removePrefix%;*}
            pid=$removeSuffix
    
            debugString="BROWSERBROWSERBROWSERBROWSER debug me @ $pid"
            echo >&2 "$debugString"
            exit 0
      
          fi
        done < <(printf '%s\n' "$processString")
        exit 0;
        `]
      )

      runningProcess = this._execCommand
    }

    const useNormal = () => {
      this._execCommand(
        command,
        [url, `--user-data-dir=${userDataDir}`].concat(this._getOptions())
      )

      runningProcess = this._process
    }

    if (isWsl) {
      if (!this.DEFAULT_CMD.linux || !which.sync(this.DEFAULT_CMD.linux, { nothrow: true })) {
        // If Chrome is not installed on Linux side then always use windows.
        useWindowsWSL()
      } else {
        if (!this._getOptions().includes('--headless') && !process.env.DISPLAY) {
          // If not in headless mode it will fail so use windows in that case.
          useWindowsWSL()
        } else {
          // Revert back to Linux command.
          command = this.DEFAULT_CMD.linux
          useNormal()
        }
      }
    } else {
      useNormal()
    }

    runningProcess.stderr.on('data', errBuff => {
      var errString
      if (typeof errBuff === 'string') {
        errString = errBuff
      } else {
        var decoder = new StringDecoder('utf8')
        errString = decoder.write(errBuff)
      }
      var matches = errString.match(/BROWSERBROWSERBROWSERBROWSER\s+debug me @ (\d+)/)
      if (matches) {
        browserProcessPid = parseInt(matches[1], 10)
      }
    })
  }

  this.on('kill', function (done) {
    // If we have a separate browser process PID, try killing it.
    if (browserProcessPid) {
      try {
        windowsUsed
          ? exec(`Taskkill.exe /PID ${browserProcessPid} /F /FI "STATUS eq RUNNING"`)
          : process.kill(browserProcessPid)
      } catch (e) {
        // Ignore failure -- the browser process might have already been
        // terminated.
      }
    }

    return process.nextTick(done)
  })
}

// Return location of chrome.exe file for a given Chrome directory (available: "Chrome", "Chrome SxS").
function getChromeExe(chromeDirName) {
  // Only run these checks on win32
  if (process.platform !== 'win32') {
    return null
  }
  var windowsChromeDirectory, i, prefix
  var suffix = '\\Google\\' + chromeDirName + '\\Application\\chrome.exe'
  var prefixes = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]

  for (i = 0; i < prefixes.length; i++) {
    prefix = prefixes[i]
    try {
      windowsChromeDirectory = path.join(prefix, suffix)
      fs.accessSync(windowsChromeDirectory)
      return windowsChromeDirectory
    } catch (e) { }
  }

  return windowsChromeDirectory
}

var ChromiumBrowser = function (baseBrowserDecorator, args) {
  ChromeBrowser.apply(this, arguments)

  const flags = args.flags || []
  const userDataDir = args.chromeDataDir || this._tempDir

  this._getOptions = function () {
    // Chromium CLI options
    // http://peter.sh/experiments/chromium-command-line-switches/
    flags.forEach(function (flag, i) {
      if (isJSFlags(flag)) {
        flags[i] = sanitizeJSFlags(flag)
      }
    })

    return [
      '--user-data-dir=' + userDataDir,
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-default-apps',
      '--disable-popup-blocking',
      '--disable-translate',
      '--disable-background-timer-throttling'
    ].concat(flags)
  }
}

// Return location of Chromium's chrome.exe file.
function getChromiumExe(chromeDirName) {
  // Only run these checks on win32
  if (process.platform !== 'win32') {
    return null
  }
  var windowsChromiumDirectory, i, prefix
  var suffix = '\\Chromium\\Application\\chrome.exe'
  var prefixes = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]

  for (i = 0; i < prefixes.length; i++) {
    prefix = prefixes[i]
    try {
      windowsChromiumDirectory = path.join(prefix, suffix)
      fs.accessSync(windowsChromiumDirectory)
      return windowsChromiumDirectory
    } catch (e) { }
  }

  return windowsChromiumDirectory
}

function getBin(commands) {
  // Don't run these checks on win32
  if (process.platform !== 'linux') {
    return null
  }
  var bin, i
  for (i = 0; i < commands.length; i++) {
    try {
      if (which.sync(commands[i])) {
        bin = commands[i]
        break
      }
    } catch (e) { }
  }
  return bin
}

const getAllPrefixesWsl = function () {
  const drives = []
  // Some folks configure their wsl.conf to mount Windows drives without the
  // /mnt prefix (e.g. see https://nickjanetakis.com/blog/setting-up-docker-for-windows-and-wsl-to-work-flawlessly)
  //
  // In fact, they could configure this to be any number of things. So we
  // take each path, convert it to a Windows path, check if it looks like
  // it starts with a drive and then record that.
  const re = /^([A-Z]):\\/i
  for (const pathElem of process.env.PATH.split(':')) {
    if (fs.existsSync(pathElem)) {
      const windowsPath = execSync('wslpath -w "' + pathElem + '"').toString()
      const matches = windowsPath.match(re)
      if (matches !== null && drives.indexOf(matches[1]) === -1) {
        drives.push(matches[1])
      }
    }
  }

  const result = []
  // We don't have the PROGRAMFILES or PROGRAMFILES(X86) environment variables
  // in WSL so we just hard code them.
  const prefixes = ['Program Files', 'Program Files (x86)']
  for (const prefix of prefixes) {
    for (const drive of drives) {
      // We only have the drive, and only wslpath knows exactly what they map to
      // in Linux, so we convert it back here.
      const wslPath =
        execSync('wslpath "' + drive + ':\\' + prefix + '"').toString().trim()
      result.push(wslPath)
    }
  }

  return result
}

const getChromeExeWsl = function (chromeDirName) {
  if (!isWsl) {
    return null
  }

  const chromeDirNames = Array.prototype.slice.call(arguments)

  for (const prefix of getAllPrefixesWsl()) {
    for (const dir of chromeDirNames) {
      const candidate = path.join(prefix, 'Google', dir, 'Application', 'chrome.exe')
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
  }

  return path.join('/mnt/c/Program Files/', 'Google', chromeDirNames[0], 'Application', 'chrome.exe')
}

const getChromiumExeWsl = function () {
  if (!isWsl) {
    return null
  }

  for (const prefix of getAllPrefixesWsl()) {
    const candidate = path.join(prefix, 'Chromium', 'Application', 'chrome.exe')
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return path.join('/mnt/c/Program Files/', 'Chromium', 'Application', 'chrome.exe')
}

function getChromeDarwin(defaultPath) {
  if (process.platform !== 'darwin') {
    return null
  }

  try {
    var homePath = path.join(process.env.HOME, defaultPath)
    fs.accessSync(homePath)
    return homePath
  } catch (e) {
    return defaultPath
  }
}

ChromeBrowser.prototype = {
  name: 'Chrome',

  DEFAULT_CMD: {
    linux: getBin(['google-chrome', 'google-chrome-stable']),
    darwin: getChromeDarwin('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    win32: isWsl ? getChromeExeWsl('Chrome') : getChromeExe('Chrome')
  },
  ENV_CMD: 'CHROME_BIN'
}

ChromeBrowser.$inject = ['baseBrowserDecorator', 'args']

function headlessGetOptions(url, args, parent) {
  var mergedArgs = parent.call(this, url, args).concat([
    '--headless',
    '--disable-gpu',
    '--disable-dev-shm-usage'
  ])

  // Headless does not work with sandboxing with WSL
  if (isWsl) { mergedArgs.push('--no-sandbox') }

  var isRemoteDebuggingFlag = function (flag) {
    return flag.indexOf('--remote-debugging-port=') !== -1
  }

  return mergedArgs.some(isRemoteDebuggingFlag)
    ? mergedArgs
    : mergedArgs.concat(['--remote-debugging-port=9222'])
}

var ChromeHeadlessBrowser = function (baseBrowserDecorator, args) {
  ChromeBrowser.apply(this, arguments)

  var parentOptions = this._getOptions
  this._getOptions = function (url) {
    return headlessGetOptions.call(this, url, args, parentOptions)
  }
}

ChromeHeadlessBrowser.prototype = {
  name: 'ChromeHeadless',

  DEFAULT_CMD: {
    linux: getBin(['google-chrome', 'google-chrome-stable']),
    darwin: getChromeDarwin('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    win32: isWsl ? getChromeExeWsl('Chrome') : getChromeExe('Chrome')
  },
  ENV_CMD: 'CHROME_BIN'
}

ChromeHeadlessBrowser.$inject = ['baseBrowserDecorator', 'args']

function canaryGetOptions(url, args, parent) {
  // disable crankshaft optimizations, as it causes lot of memory leaks (as of Chrome 23.0)
  var flags = args.flags || []
  var augmentedFlags
  var customFlags = '--nocrankshaft --noopt'

  flags.forEach(function (flag) {
    if (isJSFlags(flag)) {
      augmentedFlags = sanitizeJSFlags(flag) + ' ' + customFlags
    }
  })

  return parent.call(this, url).concat([augmentedFlags || '--js-flags=' + customFlags])
}

var ChromeCanaryBrowser = function (baseBrowserDecorator, args) {
  ChromeBrowser.apply(this, arguments)

  var parentOptions = this._getOptions
  this._getOptions = function (url) {
    return canaryGetOptions.call(this, url, args, parentOptions)
  }
}

ChromeCanaryBrowser.prototype = {
  name: 'ChromeCanary',

  DEFAULT_CMD: {
    linux: getBin(['google-chrome-canary', 'google-chrome-unstable']),
    darwin: getChromeDarwin('/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'),
    win32: isWsl ? getChromeExeWsl('Chrome SxS') : getChromeExe('Chrome SxS')
  },
  ENV_CMD: 'CHROME_CANARY_BIN'
}

ChromeCanaryBrowser.$inject = ['baseBrowserDecorator', 'args']

var ChromeCanaryHeadlessBrowser = function (baseBrowserDecorator, args) {
  ChromeCanaryBrowser.apply(this, arguments)

  var parentOptions = this._getOptions
  this._getOptions = function (url) {
    return headlessGetOptions.call(this, url, args, parentOptions)
  }
}

ChromeCanaryHeadlessBrowser.prototype = {
  name: 'ChromeCanaryHeadless',

  DEFAULT_CMD: {
    linux: getBin(['google-chrome-canary', 'google-chrome-unstable']),
    darwin: getChromeDarwin('/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'),
    win32: isWsl ? getChromeExeWsl('Chrome SxS') : getChromeExe('Chrome SxS')
  },
  ENV_CMD: 'CHROME_CANARY_BIN'
}

ChromeCanaryHeadlessBrowser.$inject = ['baseBrowserDecorator', 'args']

ChromiumBrowser.prototype = {
  name: 'Chromium',

  DEFAULT_CMD: {
    // Try chromium-browser before chromium to avoid conflict with the legacy
    // chromium-bsu package previously known as 'chromium' in Debian and Ubuntu.
    linux: getBin(['chromium-browser', 'chromium']),
    darwin: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    win32: isWsl ? getChromiumExeWsl() : getChromiumExe()
  },
  ENV_CMD: 'CHROMIUM_BIN'
}

ChromiumBrowser.$inject = ['baseBrowserDecorator', 'args']

var ChromiumHeadlessBrowser = function (baseBrowserDecorator, args) {
  ChromiumBrowser.apply(this, arguments)

  var parentOptions = this._getOptions
  this._getOptions = function (url) {
    return headlessGetOptions.call(this, url, args, parentOptions)
  }
}

ChromiumHeadlessBrowser.prototype = {
  name: 'ChromiumHeadless',

  DEFAULT_CMD: {
    // Try chromium-browser before chromium to avoid conflict with the legacy
    // chromium-bsu package previously known as 'chromium' in Debian and Ubuntu.
    linux: getBin(['chromium-browser', 'chromium']),
    darwin: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    win32: isWsl ? getChromiumExeWsl() : getChromiumExe()
  },
  ENV_CMD: 'CHROMIUM_BIN'
}

var DartiumBrowser = function () {
  ChromeBrowser.apply(this, arguments)

  var checkedFlag = '--checked'
  var dartFlags = process.env.DART_FLAGS || ''
  var flags = dartFlags.split(' ')
  if (flags.indexOf(checkedFlag) === -1) {
    flags.push(checkedFlag)
    process.env.DART_FLAGS = flags.join(' ')
  }
}

DartiumBrowser.prototype = {
  name: 'Dartium',
  DEFAULT_CMD: {},
  ENV_CMD: 'DARTIUM_BIN'
}

DartiumBrowser.$inject = ['baseBrowserDecorator', 'args']

// PUBLISH DI MODULE
module.exports = {
  'launcher:Chrome': ['type', ChromeBrowser],
  'launcher:ChromeHeadless': ['type', ChromeHeadlessBrowser],
  'launcher:ChromeCanary': ['type', ChromeCanaryBrowser],
  'launcher:ChromeCanaryHeadless': ['type', ChromeCanaryHeadlessBrowser],
  'launcher:Chromium': ['type', ChromiumBrowser],
  'launcher:ChromiumHeadless': ['type', ChromiumHeadlessBrowser],
  'launcher:Dartium': ['type', DartiumBrowser]
}

module.exports.test = {
  isJSFlags: isJSFlags,
  sanitizeJSFlags: sanitizeJSFlags,
  headlessGetOptions: headlessGetOptions,
  canaryGetOptions: canaryGetOptions
}
