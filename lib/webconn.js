// Transforms bittorrent protocol into HTTP protocol
var debug = require('debug')('bittorrent-swarm:webconn')
var inherits = require('util').inherits
var stream = require('stream')
var Duplex = stream.Duplex
var bitfield = require('bitfield')
var get = require('simple-get') // browser exclude

var hat = require('hat')

var Wire = require('bittorrent-protocol')

inherits(WebConn, Wire)

function WebConn (url, parsedTorrent) {
  var self = this
  Wire.call(this)
  self.url = url
  self.parsedTorrent = parsedTorrent

  // TODO: is this a proper peer id? how about a hash of the URL?
  self.remotePeerId = new Buffer(hat(80), 'utf8')

  //self.amInterested = true

  self.setKeepAlive(true)

  self.on('handshake', function (infoHash, peerId) {
    self.handshake(infoHash, self.remotePeerId)
    var numPieces = self.parsedTorrent.pieces.length
    var bits = bitfield(numPieces)
    for (var i = 0; i <= numPieces; i++) {
      bits.set(i, true)
    }
    self.bitfield(bits.buffer)
  })

  self.on('choke', function () {
    debug('choke', arguments)
  })
  self.on('unchoke', function () {
    debug('unchoke', arguments)
  })
  self.once('interested', function () {
    debug('interested', arguments)
    self.unchoke()
  })
  self.on('uninterested', function () {
    debug('uninterested', arguments)
  })
  self.on('bitfield', function (bitfield) {
    debug('bitfield', arguments)
  })
  self.on('request', function (pieceIndex, offset, length, callback) {
    debug('request')
    // ... read block ...
    self.httpRequest(pieceIndex, offset, length, callback)
    //callback(null, block) // respond back to the peer
  })
}

// TODO: support pieceIndexes
WebConn.prototype.httpRequest = function (pieceIndex, offset, length, cb) {
  var self = this
  var pieceLength = self.parsedTorrent.pieceLength
  var pieceOffset = pieceLength * pieceIndex
  var start = pieceOffset + offset
  var end = start + length - 1

  debug('Requesting pieceIndex=%s offset=%s length=%s start=%s end=%s', pieceIndex, offset, length, start, end)

  get.concat({
    url: self.url,
    method: 'GET',
    headers: {
      'user-agent': 'webtorrent',
      'range': 'bytes=' + start + '-' + end
    }
  }, function (err, data, res) {
    if (err) return cb(err)
    if (res.statusCode < 200 || res.statusCode >= 300)
      return cb(new Error('Unexpected HTTP status code ' + res.statusCode))

    console.log(data.length)
    cb(null, data)
  })
}

/*
WebConn.prototype.destroy = function () {
}
*/

module.exports = WebConn
