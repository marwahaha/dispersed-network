/*
   __   __  __  ___ __  __  ___ __
  |  \|/__`|__)|__ |__)/__`|__ |  \
  |__/|.__/|   |___|  \.__/|___|__/
              ______    __  __
         |\ ||__  ||  |/  \|__)|__/
         | \||___ ||/\|\__/|  \|  \

 dispersed network proof of concept
 (C) 2017 Adam K Dean <akd@dadi.co> */
 
'use strict'

const _ = require('lodash')
const os = require('os')
const amqp = require('amqplib/callback_api')
const request = require('request')
const util = require('./util.js')
const docker = require('./docker.js')
const config = require('../config.js')

const hostname = os.hostname()
const queueAddress = config.get('queue.address')
const exchangeName = config.get('queue.exchangeName')
const defaultReconnectTimeout = config.get('queue.defaultReconnectTimeout')
const maxReconnectTimeout = config.get('queue.maxReconnectTimeout')

function Host() { }

Host.prototype.init = function () {
  this.initQueue()
}

Host.prototype.initQueue = function () {
  // Connect to AMQP
  console.log('connecting to queue')
  this.connect((err) => {
    if (err) {
      console.log('queue connection failed')
      this.reconnect()
      return
    }

    // Bind to exchange, queue, etc
    console.log('connected, binding to exchange')
    this._reconnectTimeout = defaultReconnectTimeout
    
    this.bindFunctionToRoutingKey('start.*', this.onStartMsg.bind(this))
    this.bindFunctionToRoutingKey('stop.*', this.onStopMsg.bind(this))
    this.bindFunctionToRoutingKey('request.*', this.onRequest.bind(this))
  })
}

Host.prototype.connect = function (done) {
  amqp.connect(queueAddress, (err, connection) => {
    if (err) return done(err)
    connection.createChannel((err, channel) => {
      if (err) return done(err)

      this._connection = connection
      this._connection.on('error', this.onConnectionError.bind(this))
      this._channel = channel
      this._channel.on('close', this.onChannelClose.bind(this))
      this._channel.on('error', this.onChannelError.bind(this))
      this._channel.on('blocked', this.onChannelBlocked.bind(this))
      this._channel.on('unblocked', this.onChannelUnblocked.bind(this))

      done()
    })
  })
}

Host.prototype.reconnect = function () {
  // Double the time we wait before reconnecting each time upto a maximum amount
  if (this._reconnectTimeout && this._reconnectTimeout <= maxReconnectTimeout) {
    if (this._reconnectTimeout * 2 < maxReconnectTimeout) {
      this._reconnectTimeout = this._reconnectTimeout * 2
    } else {
      this._reconnectTimeout = maxReconnectTimeout
    }
  } else {
    this._reconnectTimeout = defaultReconnectTimeout
  }

  // Attempt to reconnect, but use an instance so we don't fire multiple attempts
  console.log(`queue reconnecting in ${this._reconnectTimeout} ms`)
  if (this._reconnectTimeoutInstance) clearTimeout(this._reconnectTimeoutInstance)
  this._reconnectTimeoutInstance = setTimeout(this.initQueue.bind(this), this._reconnectTimeout)
}

Host.prototype.onConnectionError = function (err) {
  console.log('queue connection error', err)
  this.reconnect()
}

Host.prototype.onChannelClose = function () {
  console.log('queue channel closed')
  this.reconnect()
}

Host.prototype.onChannelError = function (err) {
  console.log('queue channel error', err)
  this.reconnect()
}

Host.prototype.onChannelBlocked = function () {
  console.log('queue channel is blocked')
  this._serviceUnavailable = true
}

Host.prototype.onChannelUnblocked = function () {
  console.log('queue channel is unblocked')
  this._serviceUnavailable = false
}

Host.prototype.bindFunctionToRoutingKey = function (routingKey, fn) {
  // Assert topic exchange, create exclusive queue, and wait for requests
  this._channel.assertExchange(exchangeName, 'topic', { durable: false })
  this._channel.assertQueue('', { exclusive: true }, (err, q) => {
    this._channel.bindQueue(q.queue, exchangeName, routingKey)
    this._channel.consume(q.queue, fn, { noAck: true })
    console.log(`queue bound to ${routingKey}`)
  })
}


Host.prototype.onStartMsg = function (msg) {
  console.log(`\nconsume <-- ${exchangeName}: ${msg.fields.routingKey}: ${msg.content.toString()}`)
  
  const name = msg.fields.routingKey.split('.')[1]
  docker.getContainerInfo(name, (err, info) => {
    if (!err) {
      if (info && info.State !== 'running') {
        console.log(`starting container ${info.Id} (previously ${info.State})`)
        docker.startContainer(info.Id)
      } else if (!info) {
        console.log(`running container with name ${name}`)
        docker.runContainer(name)
      }
    }
  })
}

Host.prototype.onStopMsg = function (msg) {
  console.log(`\nconsume <-- ${exchangeName}: ${msg.fields.routingKey}: ${msg.content.toString()}`)
  
  const name = msg.fields.routingKey.split('.')[1]
  docker.getContainerInfo(name, (err, info) => {
    if (!err) {
      if (info && info.State === 'running') {
        console.log(`stopping container ${info.Id}`)
        docker.stopContainer(info.Id)
      }
    }
  })
}

Host.prototype.onRequest = function (msg) {
  console.log(`\nconsume <-- ${exchangeName}: ${msg.fields.routingKey}: ${msg.content.toString()}`)

  const name = msg.fields.routingKey.split('.')[1]
  const requestMsg = JSON.parse(msg.content.toString())
  console.log('>', requestMsg)

  docker.getContainerInfo(name, (err, info) => {
    if (!err) {
      if (info && info.State === 'running') {
        const containerIP =
          info.NetworkSettings &&
          info.NetworkSettings.Networks &&
          info.NetworkSettings.Networks.bridge &&
          info.NetworkSettings.Networks.bridge.IPAddress
        const reconstructedUrl = `http://${containerIP}${requestMsg.url}`
        console.log(`querying ${reconstructedUrl}...`)
        request({
          url: reconstructedUrl,
          headers: Object.assign({}, requestMsg.headers, {
            // X-Forwarded-For etc...
          })
        }, (error, response, body) => {
          console.log('error:', error)
          console.log('response:', response)
          console.log('body:', body)

          const routingKey = `response.${util.toSlug(requestMsg.hostname)}`
          const responseMsg = {
            id: requestMsg.id,
            response: body
          }

          this._channel.publish(exchangeName, routingKey, util.toBufferJSON(responseMsg))
        })
      }
    }
  })
}

module.exports = exports = function () {
  const host = new Host()
  host.init()
}