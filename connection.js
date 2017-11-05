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
      this.connectActions.push(action);
    }
  }
  ConnectionManager.prototype.addDisconnectAction = function(action) {
    if (typeof action === "function") {
      this.disconnectActions.push(action);
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
        action.apply();
      } catch (e) {
        // in case the page that registered the handler has been unloaded
      }
    });
    this.connectActions = [];
  }
  ConnectionManager.prototype.executeDisconnectActions = function(message) {
    this.disconnectActions.forEach(function(action) {
      try {
        action.apply(this, message);
      } catch (e) {
        // in case the page that registered the handler has been unloaded
      }
    });
    this.disconnectActions = [];
  }
  ConnectionManager.prototype.setSchema = function (schema) {
    this.schema = schema
  }
  ConnectionManager.prototype.disconnect = function () {
    this.connection.close();
  }
  ConnectionManager.prototype.connect = function (options) {
    var connectionCallback = (function (results) {
      if (!results.error) {
        this.connection = results.connection
        this.lostConnection = false
        this.version = results.context.connection.properties.version
        this.sender = this.connection.open_sender();
        this.receiver = this.connection.open_receiver({source: {dynamic: true}});
        this.receiver.on('receiver_open', (function(context) {
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
    if (!options.connection) {
      options.reconnect = true
      this.testConnect(options, connectionCallback)
    } else {
      connectionCallback(options)
    }
  }
  ConnectionManager.prototype.is_connected = function () {
    return this.connection && !this.lostConnection
  }
  ConnectionManager.prototype.getReceiverAddress = function () {
    return this.receiver.remote.attach.source.address
  }
  // Called to see if a connection can be established on this address:port
  // Returns the context and either the connection or an error
  ConnectionManager.prototype.testConnect = function (options, callback) {
    var conn = {connection: undefined}
    var reconnect = typeof options.reconnect !== 'undefined' ? options.reconnect : false
    console.log("connection with reconnect of " + reconnect)
    var baseAddress = options.address + ':' + options.port;
    var protocol = "ws"
    if (this.protocol === "https")
      protocol = "wss"

    var ws = rhea.websocket_connect(WebSocket)
    conn.connection = rhea.connect({
      connection_details: ws(protocol + "://" + baseAddress, ["binary"]),
      reconnect: reconnect,
      properties: {
        console_identifier: "Dispatch console"
      }
    })
    var removeListener = function () {
      conn.connection.removeListener('disconnected', disconnected)
    }
    var disconnected = function (context) {
      conn.connection.close()
      setTimeout(removeListener, 1)
      callback({error: "failed to connect", context: context})
    }
    conn.connection.on('disconnected', disconnected)
    conn.connection.on("connection_open", function (context) {
      callback({connection: conn.connection, context: context})
    })
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
    var fullAddr = self._fullAddr(toAddr);
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