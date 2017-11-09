/*
 * Copyright 2015 Red Hat Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

var util = require('./utilities.js');
var rhea = require('rhea')

  var Correlator = function () {
    this._objects = {}
    this._correlationID = 0
    this.maxCorrelatorDepth = 10
    this.lostConnection = false

  }
  Correlator.prototype.corr = function () {
    return ++(this._correlationID) + ""
  }
  // Associate this correlation id with the promise's resolve and reject methods
  Correlator.prototype.register = function (id, resolve, reject) {
    this._objects[id] = {resolver: resolve, rejector: reject}
  }
  // Call the promise's resolve method.
  // This is called by rhea's receiver.on('message') function
  Correlator.prototype.resolve = function (context) {
    var correlationID = context.message.correlation_id;
    // call the promise's resolve function with a copy of the rhea response (so we don't keep any references to internal rhea data)
    this._objects[correlationID].resolver(util.copy(context.message.body), context);
    delete this._objects[correlationID];
  }
  Correlator.prototype.reject = function (id, error) {
    this._objects[id].rejector(error);
    delete this._objects[id];
  }
  // Return the number of requests that can be sent before we start queuing requests
  Correlator.prototype.depth = function () {
    return Math.max(1, this.maxCorrelatorDepth - Object.keys(this._objects).length)
  }

  var ConnectionManager = function (protocol) {
    this.sender = undefined
    this.receiver = undefined
    this.connection = undefined
    this.version = undefined
    this.errorText = undefined
    this.protocol = protocol
    this.schema = undefined
    this.connectActions = []
    this.disconnectActions = []

    this.correlator = new Correlator()
    this.ws = rhea.websocket_connect(WebSocket)
  }

  ConnectionManager.prototype.versionCheck = function (minVer) {
    var verparts = this.version.split('.')
    var minparts = minVer.split('.')
    try {
      for (var i=0; i<minparts.length; ++i) {
        if (parseInt(minVer[i] > parseInt(verparts[i])))
          return false
      }
    } catch (e) {
      return false
    }
    return true
  }
  ConnectionManager.prototype.addConnectAction = function(action) {
    if (typeof action === "function") {
      this.delConnectAction(action)
      this.connectActions.push(action);
    }
  }

  ConnectionManager.prototype.addDisconnectAction = function(action) {
    if (typeof action === "function") {
      this.delDisconnectAction(action)
      this.disconnectActions.push(action);
    }
  }
  ConnectionManager.prototype.delConnectAction = function(action) {
    if (typeof action === "function") {
      var index = this.connectActions.indexOf(action)
      if (index >= 0)
        this.connectActions.splice(index, 1)
    }
  }
  ConnectionManager.prototype.delDisconnectAction = function(action) {
    if (typeof action === "function") {
      var index = this.disconnectActions.indexOf(action)
      if (index >= 0)
        this.disconnectActions.splice(index, 1)
    }
  }
  ConnectionManager.prototype.executeConnectActions = function() {
    this.connectActions.forEach(function(action) {
      try {
        action();
      } catch (e) {
        // in case the page that registered the handler has been unloaded
      }
    });
  }
  ConnectionManager.prototype.executeDisconnectActions = function(message) {
    this.disconnectActions.forEach(function(action) {
      try {
        action(message)
      } catch (e) {
        // in case the page that registered the handler has been unloaded
      }
    });
    this.disconnectActions = [];
  }
  ConnectionManager.prototype.setSchema = function (schema) {
    this.schema = schema
  }
  ConnectionManager.prototype.is_connected = function () {
    return this.connection &&
          this.sender &&
          this.receiver &&
          this.receiver.remote &&
          this.receiver.remote.attach  &&
          this.receiver.remote.attach.source &&
          this.receiver.remote.attach.source.address  &&
          !this.lostConnection
  }
  ConnectionManager.prototype.disconnect = function () {
    this.connection.close();
  }
  ConnectionManager.prototype.connect = function (options) {
    var connectionCallback = (function (results) {
      if (!results.error) {
        this.lostConnection = false
        this.version = results.context.connection.properties.version
        this.sender = this.connection.open_sender();
        this.receiver = this.connection.open_receiver({source: {dynamic: true}});
        this.receiver.on('receiver_open', (function(context) {
          this.lostConnection = false
          this.executeConnectActions();
        }).bind(this))
        this.receiver.on("message", (function(context) {
          this.correlator.resolve(context);
        }).bind(this));
        this.connection.on('disconnected', (function(context) {
          this.errorText = "Unable to connect"
          this.lostConnection = true
          this.executeDisconnectActions(this.errorText)
        }).bind(this))
        this.connection.on('connection_close', (function(context) {
          this.errorText = "Disconnected"
          this.lostConnection = true
          this.executeDisconnectActions(this.errorText)
        }).bind(this))
      } else {
        this.errorText = "Unable to connect"
        this.executeDisconnectActions(this.errorText)
      }
    }).bind(this)
    this.testConnect(options, connectionCallback)
  }
  ConnectionManager.prototype.getReceiverAddress = function () {
    return this.receiver.remote.attach.source.address
  }
  // Called to see if a connection can be established on this address:port
  // Returns the context and either the connection or an error
  ConnectionManager.prototype.testConnect = function (options, callback) {
    var reconnect = options.reconnect || false  // in case options.reconnect is undefined
    var baseAddress = options.address + ':' + options.port;
    var protocol = "ws"
    if (this.protocol === "https")
      protocol = "wss"

    if (this.connection)
      delete this.connection

    this.connection = rhea.connect({
      connection_details: this.ws(protocol + "://" + baseAddress, ["binary"]),
      reconnect: reconnect,
      properties: {
        console_identifier: "Dispatch console"
      }
    })
    var disconnected = function (context) {
      this.connection.removeListener('disconnected', disconnected)
      this.lostConnection = true
      if (callback) {
        var cb = callback
        callback = null
        cb({error: "failed to connect", context: context})
      }
    }
    var connection_open = function (context) {
      this.connection.removeListener('disconnected', bound_disconnected)
      this.connection.removeListener('connection_open', bound_connection_open)
      // if a non-reconnect attempt suceeds, close the connection and reopen with reconnect=true
      if (!reconnect) {
        this.lostConnection = true
        var cb = callback
        callback = null   // prevent duplicate calls of callback when disconnected event fires after the close()
        this.connection.close()
        delete this.connection
        cb({})
        return
      }
      if (callback)
        callback({context: context})
    }
    var bound_disconnected = disconnected.bind(this)
    var bound_connection_open = connection_open.bind(this)
    this.connection.on('disconnected', bound_disconnected)
    this.connection.on("connection_open", bound_connection_open)
  }

  ConnectionManager.prototype.sendMgmtQuery = function (operation) {
    return this.send([], "/$management", operation)
  }
  ConnectionManager.prototype.sendQuery = function (toAddr, entity, attrs, operation) {
    operation = operation || "QUERY"
    var fullAddr = this._fullAddr(toAddr);
    var body = {attributeNames: attrs || []}
    return this.send(body, fullAddr, operation, this.schema.entityTypes[entity].fullyQualifiedType);
  }
  ConnectionManager.prototype.send = function (body, to, operation, entityType) {
    var application_properties = {
      operation: operation,
      type: "org.amqp.management",
      name: "self"
    }
    if (entityType)
      application_properties.entityType = entityType;
    return this._send(body, to, application_properties)
  }
  ConnectionManager.prototype.sendMethod = function (toAddr, entity, attrs, operation, props) {
    var fullAddr = this._fullAddr(toAddr);
    var application_properties = {
      operation: operation,
    }
    if (entity) {
      application_properties.type = self.schema.entityTypes[entity].fullyQualifiedType
    }
    if (attrs.name)
      application_properties.name = attrs.name
    if (props) {
      jQuery.extend(application_properties, props)
    }
    return this._send(attrs, fullAddr, application_properties)
  }

  ConnectionManager.prototype._send = function (body, to, application_properties) {
    var _correlationId = this.correlator.corr()
    var self = this
    return new Promise(function(resolve, reject) {
      self.correlator.register(_correlationId, resolve, reject)
      self.sender.send({
        body: body,
        to: to,
        reply_to: self.receiver.remote.attach.source.address,
        correlation_id: _correlationId,
        application_properties: application_properties
      })
    })
  }

  ConnectionManager.prototype._fullAddr = function(toAddr) {
    var toAddrParts = toAddr.split('/');
    toAddrParts.shift()
    var fullAddr = toAddrParts.join('/');
    return fullAddr;
  }

  ConnectionManager.prototype.availableQeueuDepth = function() {
    return this.correlator.depth()
  }

module.exports = ConnectionManager;