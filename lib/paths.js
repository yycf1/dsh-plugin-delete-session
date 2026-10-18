/**
 * Path helpers that mirror the JSONL session backend's on-disk layout:
 *
 *   <sessionsRoot>/<projectKey(cwd)>/<encodeSegment(sessionId)>/
 *
 * The backend encodes both the project directory and the session id so that an
 * arbitrary header value can never escape the configured root. The same rules
 * are reproduced here (they are a small, stable part of the storage format)
 * so this plugin can address one session directory without scanning the whole
 * history tree.
 */

import path from 'node:path'

const SAFE_SEGMENT = /^[A-Za-z0-9._-]$/

/**
 * Encode an arbitrary string as one safe path segment, injectively.
 *
 * @param {string} raw value to encode.
 * @returns {string} filesystem-safe segment.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new TypeError('cannot encode an empty path segment')
  }
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char !== '~' && SAFE_SEGMENT.test(char)) out += char
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Build the readable project directory key for a recorded cwd.
 *
 * @param {string} cwd session's recorded directory.
 * @returns {string} project directory name under the sessions root.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError('cannot encode an empty project path')
  }
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (char !== '~' && SAFE_SEGMENT.test(char)) {
      readable += char
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Directory that owns one session's log artifacts.
 *
 * @param {string} root configured sessions root.
 * @param {string | undefined} cwd recorded session directory.
 * @param {string} id session id.
 * @returns {string} absolute session directory.
 */
export function sessionDir(root, cwd, id) {
  const project = cwd === undefined || cwd === ''
    ? '_no-cwd'
    : projectKey(cwd)
  return path.join(root, project, encodeSegment(id))
}

/**
 * Whether a string is safe as one path segment on this host.
 *
 * Rejects the traversal spellings and every character that can change how a
 * joined path is interpreted. Encoding still happens at the filesystem
 * boundary; this check exists so a metadata value cannot reach a raw path join
 * (notably the projection-cache filename) in the first place.
 *
 * @param {unknown} value candidate segment.
 * @returns {boolean} true for one ordinary path segment.
 */
export function isSafePathSegment(value) {
  return typeof value === 'string'
    && value !== ''
    && value !== '.'
    && value !== '..'
    && !/[\\/\u0000-\u001F]/.test(value)
}

/**
 * Validate a stored or requested session id.
 *
 * @param {unknown} value candidate session id.
 * @returns {boolean} true when the id is one safe segment.
 */
export function isSafeSessionId(value) {
  return isSafePathSegment(value)
    && value.length <= 512
    && !/[<>:"|?*]/.test(value)
}

/**
 * Validate a recorded project-directory name from trash metadata.
 *
 * @param {unknown} value candidate project directory name.
 * @returns {boolean} true when the name is one safe directory segment.
 */
export function isSafeProjectName(value) {
  return isSafePathSegment(value)
    && value.length <= 255
    && !/[<>:"|?*]/.test(value)
}

/**
 * Whether `child` names the same path as, or a path below, `parent`.
 *
 * @param {string} parent candidate ancestor.
 * @param {string} child candidate descendant.
 * @returns {boolean} true when containment holds.
 */
export function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative))
}

/**
 * Compare two absolute paths the way the host platform does.
 *
 * @param {string} left path.
 * @param {string} right path.
 * @returns {boolean} true when they name the same location.
 */
export function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left === right) return true
  const normalize = (value) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}
