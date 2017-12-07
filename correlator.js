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

var util = require('./utilities.js')

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
    this._objects[correlationID].resolver({response: util.copy(context.message.body), context: context});
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

module.exports = Correlator
