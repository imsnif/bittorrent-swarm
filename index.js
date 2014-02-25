module.exports = Swarm

var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var net = require('net') // or chrome-net
var once = require('once')
var portfinder = require('portfinder') // or chrome-portfinder
var speedometer = require('speedometer')
var Wire = require('bittorrent-protocol')

// Use random port above 1024
portfinder.basePort = Math.floor(Math.random() * 60000) + 1025

var MAX_SIZE = 100
var HANDSHAKE_TIMEOUT = 5000
var RECONNECT_WAIT = [1000, 5000, 15000, 30000, 60000, 120000, 300000, 600000]

/**
 * Peer
 * ====
 * A peer in the swarm. Comprised of a `net.Socket` and a `Wire`.
 *
 * @param {string} addr
 */
function Peer (addr) {
  this.addr = addr

  this.conn = null
  this.wire = null

  this.timeout = null
  this.retries = 0
}

/**
 * Called once the peer's `conn` has connected (i.e. fired 'connect')
 * @param {Socket} conn
 */
Peer.prototype.onconnect = function (conn) {
  this.conn = conn

  var wire = this.wire = new Wire()
  wire.remoteAddress = this.addr
  var destroy = once(function () {
    this.conn.destroy()
    this.conn = null
  }.bind(this))

  // Close the wire when the connection is destroyed
  conn.once('end', function () { destroy() })
  conn.once('error', function () { destroy() })
  conn.once('close', function () { wire.end() })

  wire.once('end', function () {
    this.wire = null
  }.bind(this))

  // Duplex streaming magic!
  conn.pipe(wire).pipe(conn)
}

/**
 * Pool
 * ====
 * A "pool" is a bunch of swarms all listening on the same TCP port for
 * incoming connections from peers who are interested in one of our swarms.
 * There is one Pool for every port that a swarm is listening on, and they are
 * all stored in the `Pool.pools` object. When a connection comes in, the pool
 * does the wire protocol handshake with the peer to determine which swarm they
 * are interested in, and routes the connection to the right swarm.
 *
 * @param {number} port
 */
function Pool (port) {
  this.port = port
  this.swarms = {} // infoHash -> Swarm
  this.listening = false

  // Keep track of incoming connections so we can destroy them if we need to
  // close the server later.
  this.conns = []

  this.server = net.createServer(this._onconn.bind(this))
  this.server.listen(this.port, this._onlistening.bind(this))
  this.server.on('error', this._onerror.bind(this))

  this._retries = 0
}

/**
 * In-use Pools (port -> Pool)
 */
Pool.pools = {}

/**
 * STATIC METHOD: Add a swarm to a pool, creating a new pool if necessary.
 * @param {Swarm} swarm
 */
Pool.add = function (swarm) {
  var port = swarm.port
  var pool = Pool.pools[port]

  if (!pool)
    pool = Pool.pools[port] = new Pool(port)

  pool.addSwarm(swarm)
}

/**
 * STATIC METHOD: Remove a swarm from its pool.
 * @param  {Swarm} swarm
 */
Pool.remove = function (swarm) {
  var port = swarm.port
  var pool = Pool.pools[port]
  if (!pool) return

  pool.removeSwarm(swarm)

  if (Object.keys(pool.swarms).length === 0)
    delete Pool.pools[port]
}

Pool.prototype._onlistening = function () {
  this.listening = true
  for (var infoHash in this.swarms) {
    var swarm = this.swarms[infoHash]
    swarm.emit('listening', this.port)
  }
}

Pool.prototype._onconn = function (conn) {
  // Track all conns in this pool
  this.conns.push(conn)
  conn.on('close', function () {
    this.conns.splice(this.conns.indexOf(conn))
  }.bind(this))

  var addr = conn.remoteAddress + ':' + conn.remotePort

  // On incoming connections, we expect the remote peer to send a handshake
  // first. Based on the infoHash in that handshake, route the peer to the
  // right swarm.
  var peer = new Peer(addr)
  peer.onconnect(conn)

  // Peer must send handshake in timely manner - they connected to us after all
  var timeout = setTimeout(function () {
    conn.destroy()
  }, HANDSHAKE_TIMEOUT)

  peer.wire.on('handshake', function (infoHash, peerId, extensions) {
    clearTimeout(timeout)
    var swarm = this.swarms[infoHash.toString('hex')]

    // Destroy connections from peers that handshake for an infoHash not in
    // this pool.
    if (!swarm)
      return conn.destroy()

    swarm._onincoming(peer)
  }.bind(this))
}

Pool.prototype._onerror = function (err) {
  if (err.code === 'EADDRINUSE' && this._retries < 5) {
    console.error('Address in use, retrying...')
    setTimeout(function () {
      this._retries += 1
      this.server.close()
      this.server.listen(this.port)
    }.bind(this), 1000)
  } else {
    this.listening = false
    this.swarms.forEach(function (swarm) {
      swarm.emit('error', 'Swarm listen error: ' + err.message)
    })
  }
}

/**
 * Destroy this pool.
 * @param  {function} cb
 */
Pool.prototype.destroy = function (cb) {
  // Destroy all open connections & wire objects so the server can gracefully
  // close without waiting for timeout or the remote peer to disconnect.
  this.conns.forEach(function (conn) {
    conn.destroy()
  })
  this.listening = false
  this.server.close(cb)
}

/**
 * Add a swarm to this pool.
 * @param {Swarm} swarm
 */
Pool.prototype.addSwarm = function (swarm) {
  var infoHash = swarm.infoHash.toString('hex')

  if (this.listening) {
    process.nextTick(function () {
      swarm.emit('listening')
    })
  }

  if (this.swarms[infoHash]) {
    process.nextTick(function () {
      swarm.emit('error', new Error('Swarm listen error: There is already a ' +
        'swarm with infoHash ' + swarm.infoHash.toString('hex') +
        ' listening on port ' + swarm.port))
    })
    return
  }

  this.swarms[infoHash] = swarm
}

/**
 * Remove a swarm from this pool.
 * @param  {Swarm} swarm
 */
Pool.prototype.removeSwarm = function (swarm) {
  var infoHash = swarm.infoHash.toString('hex')
  delete this.swarms[infoHash]

  if (Object.keys(this.swarms).length === 0)
    this.destroy()
}


inherits(Swarm, EventEmitter)

/**
 * Swarm
 * =====
 * Abstraction of a BitTorrent "swarm", which is handy for managing all peer
 * connections for a given torrent download. This handles connecting to peers,
 * listening for incoming connections, and doing the initial peer wire protocol
 * handshake with peers. It also tracks total data uploaded/downloaded to/from
 * the swarm.
 *
 * Events: wire, download, upload, error, close
 *
 * @param {Buffer|string} infoHash
 * @param {Buffer|string} peerId
 * @param {Object} extensions
 */
function Swarm (infoHash, peerId, extensions) {
  if (!(this instanceof Swarm)) return new Swarm(infoHash, peerId)

  EventEmitter.call(this)

  this.infoHash = typeof infoHash === 'string'
    ? new Buffer(infoHash, 'hex')
    : infoHash

  this.peerId = typeof peerId === 'string'
    ? new Buffer(peerId, 'utf8')
    : peerId

  this.extensions = extensions
  this.port = 0
  this.downloaded = 0
  this.uploaded = 0
  this.downloadSpeed = speedometer()
  this.uploadSpeed = speedometer()

  this.wires = [] // open wires (added *after* handshake)

  this._queue = [] // queue of peers to connect to
  this._peers = {} // connected peers (addr -> Peer)

  this._paused = false
  this._destroyed = false
}

Object.defineProperty(Swarm.prototype, 'ratio', {
  get: function () {
    if (this.downloaded === 0)
      return 0
    else
      return this.uploaded / this.downloaded
  }
})

Object.defineProperty(Swarm.prototype, 'numQueued', {
  get: function () {
    return this._queue.length
  }
})

Object.defineProperty(Swarm.prototype, 'numConns', {
  get: function () {
    return Object.keys(this._peers)
      .map(function (addr) {
        return this._peers[addr].conn ? 1 : 0
      }.bind(this))
      .reduce(function (prev, current) {
        return prev + current
      }, 0)
  }
})

Object.defineProperty(Swarm.prototype, 'numPeers', {
  get: function () {
    return this.wires.length
  }
})

/**
 * Add a peer to the swarm.
 * @param {string} addr  ip address and port (ex: 12.34.56.78:12345)
 */
Swarm.prototype.add = function (addr) {
  if (this._destroyed || this._peers[addr]) return
  if (!validAddr(addr)) return

  var peer = new Peer(addr)
  this._peers[addr] = peer
  this._queue.push(peer)

  this._drain()
}

/**
 * Temporarily stop connecting to new peers. Note that this does not pause new
 * incoming connections, nor does it pause the streams of existing connections
 * or their wires.
 */
Swarm.prototype.pause = function () {
  this._paused = true
}

/**
 * Resume connecting to new peers.
 */
Swarm.prototype.resume = function () {
  this._paused = false
  this._drain()
}

/**
 * Remove a peer from the swarm.
 * @param  {string} addr  ip address and port (ex: 12.34.56.78:12345)
 */
Swarm.prototype.remove = function (addr) {
  this._remove(addr)
  this._drain()
}

/**
 * Private method to remove a peer from the swarm without calling _drain().
 * @param  {string} addr  ip address and port (ex: 12.34.56.78:12345)
 */
Swarm.prototype._remove = function (addr) {
  var peer = this._peers[addr]
  if (!peer) return
  delete this._peers[addr]
  if (peer.node)
    this._queue.splice(this._queue.indexOf(peer), 1)
  if (peer.timeout)
    clearTimeout(peer.timeout)
  if (peer.wire)
    peer.wire.destroy()
}

/**
 * Listen on the given port for peer connections.
 * @param  {number=} port
 * @param  {function} onlistening
 */
Swarm.prototype.listen = function (port, onlistening) {
  if (typeof port === 'function') {
    onlistening = port
    port = undefined
  }

  if (onlistening)
    this.once('listening', onlistening)

  var onPort = function (err, port) {
    if (err)
      return this.emit('error', err)
    this.port = port
    Pool.add(this)
  }.bind(this)

  if (port)
    onPort(null, port)
  else
    portfinder.getPort(onPort)
}

/**
 * Destroy the swarm, close all open peer connections, and do cleanup.
 */
Swarm.prototype.destroy = function () {
  this._destroyed = true

  for (var addr in this._peers) {
    this._remove(addr)
  }

  Pool.remove(this)

  process.nextTick(function () {
    this.emit('close')
  }.bind(this))
}

//
// HELPER METHODS
//

/**
 * Pop a peer off the FIFO queue and connect to it. When _drain() gets called,
 * the queue will usually have only one peer in it, except when there are too
 * many peers (over `this.maxSize`) in which case they will just sit in the queue
 * until another connection closes.
 */
Swarm.prototype._drain = function () {
  if (this.numConns >= MAX_SIZE || this._paused) return

  var peer = this._queue.shift()
  if (!peer) return

  if (peer.timeout) {
    clearTimeout(peer.timeout)
    peer.timeout = null
  }

  var parts = peer.addr.split(':')
  var conn = net.connect(parts[1], parts[0])

  console.log('Connecting to ' + peer.addr)

  // Peer must respond to handshake in timely manner
  var timeout = setTimeout(function () {
    conn.destroy()
  }, HANDSHAKE_TIMEOUT)

  var onhandshake = function (infoHash) {
    clearTimeout(timeout)
    if (infoHash.toString('hex') !== this.infoHash.toString('hex'))
      return peer.conn.destroy()
    this._onwire(peer)
  }.bind(this)

  var onconnect = function () {
    peer.onconnect(conn)
    this._onconn(peer)

    var wire = peer.wire
    wire.on('handshake', onhandshake)

    // When wire dies, repeatedly attempt to reconnect to the peer, after a
    // timeout, with exponential backoff.
    wire.on('end', function () {
      if (this._destroyed
          || wire.destroyed
          || peer.retries >= RECONNECT_WAIT.length)
        return this._remove(peer.addr)

      var readd = function () {
        this._queue.push(peer)
        this._drain()
      }.bind(this)

      peer.timeout = setTimeout(readd, RECONNECT_WAIT[peer.retries++])
    }.bind(this))

    wire.handshake(this.infoHash, this.peerId, this.extensions)
  }.bind(this)

  conn.on('connect', onconnect)
  conn.on('error', function (err) {
    console.log('Failed to connect to ' + peer.addr)
  })
}

/**
 * Called whenever a new peer wants to connects to this swarm. Called with a
 * peer that has already sent us a handshake.
 * @param  {Peer} peer
 */
Swarm.prototype._onincoming = function (peer) {
  this._peers[peer.wire.remoteAddress] = peer
  peer.wire.handshake(this.infoHash, this.peerId, this.extensions)

  this._onconn(peer)
  this._onwire(peer)
}

//
// CONNECTION AND WIRE HANDLERS
//

/**
 * Called whenever a new connection is connected.
 * @param  {Socket} conn
 */
Swarm.prototype._onconn = function (peer) {
  peer.conn.once('close', function () {
    this._drain() // allow another connection to be opened
  }.bind(this))
}

/**
 * Called whenever we've handshaken with a new wire.
 * @param  {Peer} peer
 */
Swarm.prototype._onwire = function (peer) {
  var conn = peer.conn
  var wire = peer.wire

  peer.retries = 0

  // Track total bytes downloaded by the swarm
  wire.on('download', function (downloaded) {
    this.downloaded += downloaded
    this.downloadSpeed(downloaded)
    this.emit('download', downloaded)
  }.bind(this))

  // Track total bytes uploaded by the swarm
  wire.on('upload', function (uploaded) {
    this.uploaded += uploaded
    this.uploadSpeed(uploaded)
    this.emit('upload', uploaded)
  }.bind(this))

  var cleanup = once(function () {
    this.wires.splice(this.wires.indexOf(wire), 1)
    conn.destroy()
  }.bind(this))

  wire.on('end', cleanup)
  wire.on('close', cleanup)
  wire.on('error', cleanup)
  wire.on('finish', cleanup)

  this.wires.push(wire)
  this.emit('wire', wire)
}

/**
 * Is the address valid?
 * @param  {string} addr
 * @return {boolean}
 */
function validAddr (addr) {
  var port = Number(addr.split(':')[1])
  return port > 0 && port < 65535
}