const path = require('path')
const crypto = require('crypto')
const {parse: parseUrl, format: formatUrl} = require('url')
const fse = require('fs-extra')
const miss = require('mississippi')
const PQueue = require('p-queue')
const {omit} = require('lodash')
const pkg = require('../package.json')
const requestStream = require('./requestStream')
const debug = require('./debug')

const EXCLUDE_PROPS = ['_id', '_type', 'assetId', 'extension', 'mimeType', 'path', 'url']
const ACTION_REMOVE = 'remove'
const ACTION_REWRITE = 'rewrite'

class AssetHandler {
  constructor(options) {
    this.client = options.client
    this.tmpDir = options.tmpDir
    this.assetDirsCreated = false

    this.assetsSeen = new Map()
    this.assetMap = {}
    this.filesWritten = 0
    this.queueSize = 0
    this.queue = options.queue || new PQueue({concurrency: 3})
    this.reject = () => {
      throw new Error('Asset handler errored before `finish()` was called')
    }
  }

  clear() {
    this.assetsSeen.clear()
    this.queue.clear()
    this.queueSize = 0
  }

  finish() {
    return new Promise((resolve, reject) => {
      this.reject = reject
      this.queue.onIdle().then(() => resolve(this.assetMap))
    })
  }

  // Called when we want to download all assets to local filesystem and rewrite documents to hold
  // placeholder asset references (_sanityAsset: 'image@file:///local/path')
  rewriteAssets = miss.through.obj(async (doc, enc, callback) => {
    if (['sanity.imageAsset', 'sanity.fileAsset'].includes(doc._type)) {
      const type = doc._type === 'sanity.imageAsset' ? 'image' : 'file'
      const filePath = `${type}s/${generateFilename(doc._id)}`
      this.assetsSeen.set(doc._id, type)
      this.queueAssetDownload(doc, filePath, type)
      callback()
      return
    }

    callback(null, await this.findAndModify(doc, ACTION_REWRITE))
  })

  // Called in the case where we don't _want_ assets, so basically just remove all asset documents
  // as well as references to assets (*.asset._ref ^= (image|file)-)
  stripAssets = miss.through.obj(async (doc, enc, callback) => {
    if (['sanity.imageAsset', 'sanity.fileAsset'].includes(doc._type)) {
      callback()
      return
    }

    callback(null, await this.findAndModify(doc, ACTION_REMOVE))
  })

  // Called when we are using raw export mode along with `assets: false`, where we simply
  // want to skip asset documents but retain asset references (useful for data mangling)
  skipAssets = miss.through.obj((doc, enc, callback) => {
    const isAsset = ['sanity.imageAsset', 'sanity.fileAsset'].includes(doc._type)
    if (isAsset) {
      callback()
      return
    }

    callback(null, doc)
  })

  noop = miss.through.obj((doc, enc, callback) => callback(null, doc))

  queueAssetDownload(assetDoc, dstPath, type) {
    if (!assetDoc.url) {
      debug('Asset document "%s" does not have a URL property, skipping', assetDoc._id)
      return
    }

    debug('Adding download task for %s (destination: %s)', assetDoc._id, dstPath)
    this.queueSize++
    this.queue.add(() => this.downloadAsset(assetDoc, dstPath))
  }

  maybeCreateAssetDirs() {
    if (this.assetDirsCreated) {
      return
    }

    /* eslint-disable no-sync */
    fse.ensureDirSync(path.join(this.tmpDir, 'files'))
    fse.ensureDirSync(path.join(this.tmpDir, 'images'))
    /* eslint-enable no-sync */
    this.assetDirsCreated = true
  }

  getAssetRequestOptions(assetDoc) {
    const token = this.client.config().token
    const headers = {'User-Agent': `${pkg.name}@${pkg.version}`}
    const isImage = assetDoc._type === 'sanity.imageAsset'

    const url = parseUrl(assetDoc.url, true)
    if (isImage && ['cdn.sanity.io', 'cdn.sanity.work'].includes(url.hostname)) {
      headers.Authorization = `Bearer ${token}`
      url.query = {...(url.query || {}), dlRaw: 'true'}
    }

    return {url: formatUrl(url), headers}
  }

  async downloadAsset(assetDoc, dstPath, attemptNum = 0) {
    const {url} = assetDoc
    const options = this.getAssetRequestOptions(assetDoc)
    const stream = await requestStream(options)

    if (stream.statusCode !== 200) {
      this.queue.clear()
      this.reject(new Error(`Referenced asset URL "${url}" returned HTTP ${stream.statusCode}`))
      return false
    }

    this.maybeCreateAssetDirs()

    debug('Asset stream ready, writing to filesystem at %s', dstPath)
    const tmpPath = path.join(this.tmpDir, dstPath)
    const {sha1, md5} = await writeHashedStream(tmpPath, stream)

    // If we have an ETag, it should be the md5 sum of the image
    // Verify it against our downloaded stream to make sure we have the same copy
    const etag = stream.headers.etag
    const differs = etag && etag !== md5

    if (differs && attemptNum < 3) {
      debug('ETag does not match downloaded asset, retrying (#%d)', attemptNum + 1)
      return this.downloadAsset(assetDoc, dstPath, attemptNum + 1)
    } else if (differs) {
      await fse.unlink(tmpPath)
      this.queue.clear()
      this.reject(
        new Error(`Failed to download image at ${assetDoc.url} after 3 attempts, giving up`)
      )
      return false
    }

    const isImage = assetDoc._type === 'sanity.imageAsset'
    const type = isImage ? 'image' : 'file'
    const id = `${type}-${sha1}`

    const metaProps = omit(assetDoc, EXCLUDE_PROPS)
    if (Object.keys(metaProps).length > 0) {
      this.assetMap[id] = metaProps
    }

    this.filesWritten++
    return true
  }

  // eslint-disable-next-line complexity
  findAndModify = async (item, action) => {
    if (Array.isArray(item)) {
      const children = await Promise.all(item.map(child => this.findAndModify(child, action)))
      return children.filter(Boolean)
    }

    if (!item || typeof item !== 'object') {
      return item
    }

    const isAsset = isAssetField(item)
    if (isAsset && action === ACTION_REMOVE) {
      return undefined
    }

    if (isAsset && action === ACTION_REWRITE) {
      const {asset, ...other} = item
      const assetId = asset._ref
      if (isModernAsset(assetId)) {
        const assetType = getAssetType(item)
        const filePath = `${assetType}s/${generateFilename(assetId)}`
        return {
          _sanityAsset: `${assetType}@file://./${filePath}`,
          ...(await this.findAndModify(other, action))
        }
      }

      // Legacy asset
      const type = this.assetsSeen.get(assetId) || (await this.lookupAssetType(assetId))
      const filePath = `${type}s/${generateFilename(assetId)}`
      return {
        _sanityAsset: `${type}@file://./${filePath}`,
        ...(await this.findAndModify(other, action))
      }
    }

    const newItem = {}
    const keys = Object.keys(item)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const value = item[key]

      // eslint-disable-next-line no-await-in-loop
      newItem[key] = await this.findAndModify(value, action)

      if (typeof newItem[key] === 'undefined') {
        delete newItem[key]
      }
    }

    return newItem
  }

  lookupAssetType = async assetId => {
    const docType = await this.client.fetch('*[_id == $id][0]._type', {id: assetId})
    return docType === 'sanity.imageAsset' ? 'image' : 'file'
  }
}

function isAssetField(item) {
  return item.asset && item.asset._ref
}

function getAssetType(item) {
  if (!item.asset || typeof item.asset._ref !== 'string') {
    return null
  }

  const [, type] = item.asset._ref.match(/^(image|file)-/) || []
  return type || null
}

function isModernAsset(assetId) {
  return /^(image|file)/.test(assetId)
}

function generateFilename(assetId) {
  const [, , asset, ext] = assetId.match(/^(image|file)-(.*?)(-[a-z]+)?$/) || []
  const extension = (ext || 'bin').replace(/^-/, '')
  return asset ? `${asset}.${extension}` : `${assetId}.bin`
}

function writeHashedStream(filePath, stream) {
  const md5 = crypto.createHash('md5')
  const sha1 = crypto.createHash('sha1')

  const hasher = miss.through((chunk, enc, cb) => {
    md5.update(chunk)
    sha1.update(chunk)
    cb(null, chunk)
  })

  return new Promise((resolve, reject) =>
    miss.pipe(
      stream,
      hasher,
      fse.createWriteStream(filePath),
      err =>
        err
          ? reject(err)
          : resolve({
              sha1: sha1.digest('hex'),
              md5: md5.digest('hex')
            })
    )
  )
}

module.exports = AssetHandler
