/* eslint-disable no-var, prefer-template */
function errHandler(msg, url, lineNo, columnNo, error) {
  window.lolerr = error
  var err = error || msg
  var container = document.getElementById('sanity')
  var wrapper = document.createElement('div')
  wrapper.style.position = 'absolute'
  wrapper.style.top = '50%'
  wrapper.style.left = '50%'
  wrapper.style.transform = 'translate(-50%, -50%)'

  var header = document.createElement('h1')
  header.innerText = 'Uncaught error'

  var pre = document.createElement('pre')
  var stack = document.createElement('code')

  var cleanStack = err.stack && err.stack.replace(err.message, '').replace(/^error: *\n?/i, '')
  var errTitle = err.stack ? err.message : err.toString()
  var errStack = err.stack ? '\n\nStack:\n\n' + cleanStack : ''
  var errString = errTitle + errStack + '\n\n(Your browsers Developer Tools may contain more info)'
  stack.textContent = errString

  var reload = document.createElement('button')
  reload.onclick = function() {
    window.location.reload()
  }
  reload.textContent = 'Try reloading?'

  pre.appendChild(stack)
  wrapper.appendChild(header)
  wrapper.appendChild(pre)
  wrapper.appendChild(reload)

  while (container.firstChild) {
    container.removeChild(container.firstChild)
  }

  container.appendChild(wrapper)
}

export default () => `window.onerror = ${errHandler.toString()}`
