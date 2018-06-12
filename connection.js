/*
 * Copyright 2017 Red Hat Inc.
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
/* global Promise */

var rhea = require('rhea');
var Correlator = require('./correlator.js');

var ConnectionManager = function (protocol) {
  this.sender = undefined;
  this.receiver = undefined;
  this.connection = undefined;
  this.version = undefined;
  this.errorText = undefined;
  this.protocol = protocol;
  this.schema = undefined;
  this.connectActions = [];
  this.disconnectActions = [];

  this.correlator = new Correlator();

  this.on_message = (function (context) {
    this.correlator.resolve(context);
  }).bind(this);
  this.on_disconnected = (function () {
    this.errorText = 'Disconnected';
    this.executeDisconnectActions(this.errorText);
  }).bind(this);
  this.on_connection_open = (function () {
    this.executeConnectActions();
  }).bind(this);
};

ConnectionManager.prototype.versionCheck = function (minVer) {
  var verparts = this.version.split('.');
  var minparts = minVer.split('.');
  try {
    for (var i=0; i<minparts.length; ++i) {
      if (parseInt(minVer[i] > parseInt(verparts[i])))
        return false;
    }
  } catch (e) {
    return false;
  }
  return true;
};
ConnectionManager.prototype.addConnectAction = function(action) {
  if (typeof action === 'function') {
    this.delConnectAction(action);
    this.connectActions.push(action);
  }
};

ConnectionManager.prototype.addDisconnectAction = function(action) {
  if (typeof action === 'function') {
    this.delDisconnectAction(action);
    this.disconnectActions.push(action);
  }
};
ConnectionManager.prototype.delConnectAction = function(action) {
  if (typeof action === 'function') {
    var index = this.connectActions.indexOf(action);
    if (index >= 0)
      this.connectActions.splice(index, 1);
  }
};
ConnectionManager.prototype.delDisconnectAction = function(action) {
  if (typeof action === 'function') {
    var index = this.disconnectActions.indexOf(action);
    if (index >= 0)
      this.disconnectActions.splice(index, 1);
  }
};
ConnectionManager.prototype.executeConnectActions = function() {
  this.connectActions.forEach(function(action) {
    try {
      action();
    } catch (e) {
      // in case the page that registered the handler has been unloaded
    }
  });
  this.connectActions = [];
};
ConnectionManager.prototype.executeDisconnectActions = function(message) {
  this.disconnectActions.forEach(function(action) {
    try {
      action(message);
    } catch (e) {
      // in case the page that registered the handler has been unloaded
    }
  });
  this.disconnectActions = [];
};
ConnectionManager.prototype.on = function (eventType, fn) {
  if (eventType === 'connected') {
    this.addConnectAction(fn);
  } else if (eventType === 'disconnected') {
    this.addDisconnectAction(fn);
  } else {
    console.log('unknown event type ' + eventType);
  }
};

ConnectionManager.prototype.setSchema = function (schema) {
  this.schema = schema;
};
ConnectionManager.prototype.is_connected = function () {
  return this.connection &&
        this.sender &&
        this.receiver &&
        this.receiver.remote &&
        this.receiver.remote.attach  &&
        this.receiver.remote.attach.source &&
        this.receiver.remote.attach.source.address &&
        this.connection.is_open();
};
ConnectionManager.prototype.disconnect = function () {
  if (this.sender)
    this.sender.close();
  if (this.receiver)
    this.receiver.close();
  if (this.connection)
    this.connection.close();
};

ConnectionManager.prototype.createSenderReceiver = function (options) {
  return new Promise( (function (resolve, reject) {
    var timeout = options.timeout || 10000;
    // set a timer in case the setup takes too long
    var giveUp = (function () {
      this.connection.removeListener('receiver_open', receiver_open);
      this.connection.removeListener('sendable', sendable);
      this.errorText = 'timed out creating senders and receivers';
      reject(Error(this.errorText));
    }).bind(this);
    var timer = setTimeout(giveUp, timeout);

    // register an event hander for when the setup is complete
    var sendable = (function (context) {
      clearTimeout(timer);
      this.version = this.connection.properties ? this.connection.properties.version : '0.1.0';
      // in case this connection dies
      rhea.on('disconnected', this.on_disconnected);
      // in case this connection dies and is then reconnected automatically
      rhea.on('connection_open', this.on_connection_open);
      // receive messages here
      this.connection.on('message', this.on_message);
      resolve(context);
    }).bind(this);
    this.connection.once('sendable', sendable);

    // Now actually createt the sender and receiver.
    // register an event handler for when the receiver opens
    var receiver_open = (function () {
      // once the receiver is open, create the sender
      if (options.sender_address)
        this.sender = this.connection.open_sender(options.sender_address);
      else
        this.sender = this.connection.open_sender();
    }).bind(this);
    this.connection.once('receiver_open', receiver_open);
    // create a dynamic receiver
    this.receiver = this.connection.open_receiver({source: {dynamic: true}});

  }).bind(this));
};

ConnectionManager.prototype.connect = function (options) {
  return new Promise( (function (resolve, reject) {
    var finishConnecting = function () {
      this.createSenderReceiver(options)
        .then( function (results) {
          resolve(results);
        }, function (error) {
          reject(error);
        });
    };

    if (!this.connection) {
      options.test = false;  // if you didn't want a connection, you should have called testConnect() and not connect()
      this.testConnect(options)
        .then( (function () {
          finishConnecting.call(this);
        }).bind(this), (function () {
          // connect failed or timed out
          this.errorText = 'Unable to connect';
          this.executeDisconnectActions(this.errorText);
          reject(Error(this.errorText));
        }).bind(this));
    } else {
      finishConnecting.call(this);
    }
  }).bind(this));
};
ConnectionManager.prototype.getReceiverAddress = function () {
  return this.receiver.remote.attach.source.address;
};

// Try to connect using the options.
// if options.test === true -> close the connection if it succeeded and resolve the promise
// if the connection attempt fails or times out, reject the promise regardless of options.test
ConnectionManager.prototype.testConnect = function (options, callback) {
  return new Promise ( (function (resolve, reject) {
    var timeout = options.timeout || 10000;
    var reconnect = options.reconnect || false;  // in case options.reconnect is undefined
    var baseAddress = options.address + ':' + options.port;
    if (options.linkRouteAddress) {
      baseAddress += ('/'+options.linkRouteAddress);
    }
    var wsprotocol = location.protocol === 'https:' ? 'wss' : 'ws';

    if (this.connection) {
      delete this.connection;
      this.connection = null;
    }

    var ws = rhea.websocket_connect(WebSocket);
    var c = {
      connection_details: new ws(wsprotocol + '://' + baseAddress, ['binary']),
      reconnect: reconnect,
      properties: options.properties || {console_identifier: 'Dispatch console'}
    };
    if (options.hostname)
      c.hostname = options.hostname;

    if (options.username && options.username !== '') {
      c.username = options.username;
    }
    if (options.password && options.password !== '') {
      c.password = options.password;
    }
    // set a timeout
    var disconnected = (function () {
      clearTimeout(timer);
      rhea.removeListener('disconnected', disconnected);
      rhea.removeListener('connection_open', connection_open);
      this.connection = null;
      var rej = 'failed to connect';
      if (callback)
        callback({error: rej});
      reject(Error(rej));
    }).bind(this);
    var timer = setTimeout(disconnected, timeout);

    // the event handler for when the connection opens
    var connection_open = (function (context) {
      clearTimeout(timer);
      // prevent future disconnects from calling reject
      rhea.removeListener('disconnected', disconnected);

      // we were just checking. we don't really want a connection
      if (options.test) {
        context.connection.close();
        this.connection = null;
      } else
        this.on_connection_open();
      var res = {context: context};
      if (callback)
        callback(res);
      resolve(res);
    }).bind(this);

    // register an event handler for when the connection opens
    rhea.once('connection_open', connection_open);

    // register an event handler for if the connection fails to open
    rhea.once('disconnected', disconnected);

    // attempt the connection
    this.connection = rhea.connect(c);
  }).bind(this));
};

ConnectionManager.prototype.sendMgmtQuery = function (operation) {
  return this.send([], '/$management', operation);
};
ConnectionManager.prototype.sendQuery = function (toAddr, entity, attrs, operation) {
  operation = operation || 'QUERY';
  var fullAddr = this._fullAddr(toAddr);
  var body = {attributeNames: attrs || []};
  return this.send(body, fullAddr, operation, this.schema.entityTypes[entity].fullyQualifiedType);
};
ConnectionManager.prototype.send = function (body, to, operation, entityType) {
  var application_properties = {
    operation: operation,
    type: 'org.amqp.management',
    name: 'self'
  };
  if (entityType)
    application_properties.entityType = entityType;
  return this._send(body, to, application_properties);
};
ConnectionManager.prototype.sendMethod = function (toAddr, entity, attrs, operation, props) {
  var fullAddr = this._fullAddr(toAddr);
  var application_properties = {
    operation: operation,
  };
  if (entity) {
    application_properties.type = this.schema.entityTypes[entity].fullyQualifiedType;
  }
  if (attrs.name)
    application_properties.name = attrs.name;
  else if (attrs.identity)
    application_properties.identity = attrs.identity;
  if (props) {
    for (var attrname in props) { application_properties[attrname] = props[attrname]; }
  }
  return this._send(attrs, fullAddr, application_properties);
};

ConnectionManager.prototype._send = function (body, to, application_properties) {
  var _correlationId = this.correlator.corr();
  var self = this;
  return new Promise(function(resolve, reject) {
    self.correlator.register(_correlationId, resolve, reject);
    self.sender.send({
      body: body,
      to: to,
      reply_to: self.receiver.remote.attach.source.address,
      correlation_id: _correlationId,
      application_properties: application_properties
    });
  });
};

ConnectionManager.prototype._fullAddr = function(toAddr) {
  var toAddrParts = toAddr.split('/');
  toAddrParts.shift();
  var fullAddr = toAddrParts.join('/');
  return fullAddr;
};

ConnectionManager.prototype.availableQeueuDepth = function() {
  return this.correlator.depth();
};

function ConnectionException(message) {
  this.message = message;
  this.name = 'ConnectionException';
}

exports.ConnectionManager = ConnectionManager;
exports.ConnectionException = ConnectionException;
