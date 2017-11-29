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

  var Topology = function (connectionManager, schema) {
    this.connection = connectionManager
    this.updatedActions = {}
    this.entities = []          // which entities to request each topology update
    this.entityAttribs = {}
    this._nodeInfo = {}         // info about all known nodes and entities
    this.filtering = false      // filter out nodes that don't have connection info

    this.timeout = 5000
    this.updateInterval = 5000
    this._getTimer = null
    this.updating = false
  }
  Topology.prototype.addUpdatedAction = function(key, action) {
    if (angular.isFunction(action)) {
      this.updatedActions[key] = action;
    }
  }
  Topology.prototype.delUpdatedAction = function(key) {
    if (key in this.updatedActions)
      delete this.updatedActions[key];
  }
  Topology.prototype.executeUpdatedActions = function(error) {
    for (var action in this.updatedActions) {
      this.updatedActions[action].apply(this, [error]);
    }
  }
  Topology.prototype.setUpdateEntities = function (entities) {
    this.entities = entities
    for (var i=0; i<entities.length; i++) {
      this.entityAttribs[entities[i]] = []
    }
  }
  Topology.prototype.addUpdateEntities = function (entityAttribs) {
    if (Object.prototype.toString.call(entityAttribs) !== '[object Array]') {
      entityAttribs = [entityAttribs]
    }
    for (var i=0; i<entityAttribs.length; i++) {
      var entity = entityAttribs[i].entity
      this.entityAttribs[entity] = entityAttribs[i].attrs || []
    }
  }
  Topology.prototype.nodeInfo = function () {
    return this._nodeInfo
  }
  Topology.prototype.get = function () {
    this.connection.sendMgmtQuery("GET-MGMT-NODES")
      .then( (function (response) {
        response = response.response
        if (Object.prototype.toString.call(response) === '[object Array]') {
          var workInfo = {}
          // if there is only one node, it will not be returned
          if (response.length === 0) {
            var parts = this.connection.getReceiverAddress().split('/')
            parts[parts.length-1] = '$management'
            response.push(parts.join('/'))
          }
          for (var i=0; i<response.length; ++i) {
            workInfo[response[i]] = {};
          }
          var gotResponse = function (nodeName, entity, response) {
            workInfo[nodeName][entity] = response
          }
          var q = QDR.queue(this.connection.availableQeueuDepth())
          for (var id in workInfo) {
            for (var entity in this.entityAttribs) {
              q.defer((this.q_fetchNodeInfo).bind(this), id, entity, this.entityAttribs[entity], q, gotResponse)
            }
          }
          q.await((function (error) {
            // filter out nodes that have no connection info
            if (this.filtering) {
              for (var id in workInfo) {
                if (!(workInfo[id]['connection'])) {
                  this.flux = true
                  delete workInfo[id]
                }
              }
            }
            this._nodeInfo = util.copy(workInfo)
            this.onDone(this._nodeInfo)
          }).bind(this))
        };
      }).bind(this))
  }
  Topology.prototype.onDone = function (result) {
    clearTimeout(this._getTimer)
    if (this.updating)
      this._getTimer = setTimeout((this.get).bind(this), this.updateInterval)
    this.executeUpdatedActions(result)
  }

  Topology.prototype.startUpdating = function (filter) {
    this.stopUpdating();
    this.updating = true
    this.filtering = filter
    this.get()
  }
  Topology.prototype.stopUpdating = function () {
    this.updating = false
    if (this._getTimer) {
      clearTimeout(this._getTimer)
      this._getTimer = null;
    }
  }

  Topology.prototype.fetchEntity = function (node, entity, attrs, callback) {
    var results = {}
    var gotResponse = function (nodeName, dotentity, response) {
      results = response
    }
    var q = QDR.queue(this.connection.availableQeueuDepth())
    q.defer((this.q_fetchNodeInfo).bind(this), node, entity, attrs, q, gotResponse)
    q.await(function (error) {
      callback(node, entity, results)
    })
  }
  // called from d3.queue.defer so the last argument (callback) is supplied by d3
  Topology.prototype.q_fetchNodeInfo = function (nodeId, entity, attrs, q, heartbeat, callback) {
    this.getNodeInfo(nodeId, entity, attrs, q, function (nodeName, dotentity, response) {
      heartbeat(nodeName, dotentity, response)
      callback(null)
    })
  }

  // get/refreshes entities for all topology.nodes
  // call doneCallback when all data is available
  // optionally supply a resultCallBack that will be called as each result is avaialble
  // if a resultCallBack is supplied, the calling function is responsible for accumulating the responses
  //   otherwise the responses will be returned to the doneCallback as an object
  Topology.prototype.fetchAllEntities = function(entityAttribs, doneCallback, resultCallback) {
    var q = QDR.queue(this.connection.availableQeueuDepth())
    var results = {}
    if (!resultCallback) {
      resultCallback = function (nodeName, dotentity, response) {
        if (!results[nodeName])
          results[nodeName] = {}
        results[nodeName][dotentity] = response;
      }
    }
    var gotAResponse = function (nodeName, dotentity, response) {
      resultCallback(nodeName, dotentity, response)
    }
    if (Object.prototype.toString.call(entityAttribs) !== '[object Array]') {
      entityAttribs = [entityAttribs]
    }
    var nodes = Object.keys(this._nodeInfo)
    for (var n=0; n<nodes.length; ++n) {
      for (var i=0; i<entityAttribs.length; ++i) {
        var ea = entityAttribs[i]
        q.defer((this.q_fetchNodeInfo).bind(this), nodes[n], ea.entity, ea.attrs || [], q, gotAResponse)
      }
    }
    q.await(function (error) {
      doneCallback(results);
    })
  }

    // enusre all the topology nones have all these entities
  Topology.prototype.ensureAllEntities= function(entityAttribs, callback, extra) {
    this.ensureEntities(Object.keys(this._nodeInfo), entityAttribs, callback, extra)
  }

    // ensure these nodes have all these entities. don't fetch unless forced to
  Topology.prototype.ensureEntities = function(nodes, entityAttribs, callback, extra) {
    if (Object.prototype.toString.call(entityAttribs) !== '[object Array]') {
      entityAttribs = [entityAttribs]
    }
    if (Object.prototype.toString.call(nodes) !== '[object Array]') {
      nodes = [nodes]
    }
    this.addUpdateEntities(entityAttribs)
    var q = QDR.queue(this.connection.availableQeueuDepth())
    for (var n=0; n<nodes.length; ++n) {
      for (var i=0; i<entityAttribs.length; ++i) {
        var ea = entityAttribs[i]
        // if we don'e already have the entity or we want to force a refresh
        if (!this._nodeInfo[nodes[n]][ea.entity] || ea.force)
          q.defer((this.q_ensureNodeInfo).bind(this), nodes[n], ea.entity, ea.attrs || [], q)
      }
    }
    q.await(function (error) {
      callback(extra);
    })
  }
  Topology.prototype.addNodeInfo = function(id, entity, values) {
    // save the results in the nodeInfo object
    if (id) {
      if (!(id in this._nodeInfo)) {
        this._nodeInfo[id] = {};
      }
      // copy the values to allow garbage collection
      this._nodeInfo[id][entity] = values
    }
  }
  Topology.prototype.isLargeNetwork = function() {
    return Object.keys(this._nodeInfo).length >= 12
  }
  Topology.prototype.getConnForLink = function(link) {
    // find the connection for this link
    var conns = this._nodeInfo[link.nodeId]['connection']
    var connIndex = conns.attributeNames.indexOf("identity")
    var linkCons = conns.results.filter(function(conn) {
      return conn[connIndex] === link.connectionId;
    })
    return util.flatten(conns.attributeNames, linkCons[0]);
  }

  Topology.prototype.nodeNameList = function() {
    var nl = [];
    for (var id in this._nodeInfo) {
      nl.push(this.nameFromId(id));
    }
    return nl.sort();
    }
  Topology.prototype.nodeIdList = function() {
    var nl = [];
    for (var id in this._nodeInfo) {
      //if (this._nodeInfo['connection'])
        nl.push(id);
    }
    return nl.sort();
  }
  Topology.prototype.nodeList = function() {
    var nl = [];
    for (var id in this._nodeInfo) {
      nl.push({
        name: this.nameFromId(id),
        id: id
      });
    }
    return nl;
  }
  Topology.prototype.nameFromId = function(id) {
    return id.split('/')[3];
  }

  // d3.queue'd function to make a management query for entities/attributes
  Topology.prototype.q_ensureNodeInfo = function (nodeId, entity, attrs, q, callback) {
    this.getNodeInfo(nodeId, entity, attrs, q, (function (nodeName, dotentity, response) {
      this.addNodeInfo(nodeName, dotentity, response)
      callback(null)
    }).bind(this))
    return {
      abort: function() {
        delete this._nodeInfo[nodeId]
      }
    }
  }

  Topology.prototype.getNodeInfo = function (nodeName, entity, attrs, q, callback) {
    var timedOut = function (q) {
      q.abort()
    }
    var atimer = setTimeout(timedOut, this.timeout, q);
    this.connection.sendQuery(nodeName, entity, attrs)
      .then( function (response) {
        clearTimeout(atimer)
        callback(nodeName, entity, response.response);
      }, function (error) {
        q.abort()
      })
  }
  Topology.prototype.getMultipleNodeInfo = function (nodeNames, entity, attrs, callback, selectedNodeId, aggregate) {
    var self = this
    if (!angular.isDefined(aggregate))
      aggregate = true;
    var responses = {};
    var gotNodesResult = function(nodeName, dotentity, response) {
      responses[nodeName] = response;
    }

    var q = QDR.queue(this.connection.availableQeueuDepth())
    nodeNames.forEach(function(id) {
      q.defer((self.q_fetchNodeInfo).bind(self), id, entity, attrs, q, gotNodesResult)
    })
    q.await(function (error) {
      if (aggregate)
        self.aggregateNodeInfo(nodeNames, entity, selectedNodeId, responses, callback);
      else {
        callback(nodeNames, entity, responses)
      }
    })
  }
  Topology.prototype.quiesceLink = function (nodeId, name) {
    var attributes = {
      adminStatus: 'disabled',
      name: name
    };
    return this.connection.sendMethod(nodeId, "router.link", attributes, "UPDATE")
  }

  Topology.prototype.aggregateNodeInfo = function (nodeNames, entity, selectedNodeId, responses, callback) {
    // aggregate the responses
    var self = this
    var newResponse = {};
    var thisNode = responses[selectedNodeId];
    newResponse['attributeNames'] = thisNode.attributeNames;
    newResponse['results'] = thisNode.results;
    newResponse['aggregates'] = [];
    for (var i = 0; i < thisNode.results.length; ++i) {
      var result = thisNode.results[i];
      var vals = [];
      result.forEach(function(val) {
        vals.push({
          sum: val,
          detail: []
        })
      })
      newResponse.aggregates.push(vals);
    }
    var nameIndex = thisNode.attributeNames.indexOf("name");
    var ent = self.connection.schema.entityTypes[entity];
    var ids = Object.keys(responses);
    ids.sort();
    ids.forEach(function(id) {
      var response = responses[id];
      var results = response.results;
      results.forEach(function(result) {
        // find the matching result in the aggregates
        var found = newResponse.aggregates.some(function(aggregate, j) {
          if (aggregate[nameIndex].sum === result[nameIndex]) {
            // result and aggregate are now the same record, add the graphable values
            newResponse.attributeNames.forEach(function(key, i) {
              if (ent.attributes[key] && ent.attributes[key].graph) {
                if (id != selectedNodeId)
                  aggregate[i].sum += result[i];
              }
              aggregate[i].detail.push({
                node: self.nameFromId(id) + ':',
                val: result[i]
              })
            })
            return true; // stop looping
          }
          return false; // continute looking for the aggregate record
        })
        if (!found) {
          // this attribute was not found in the aggregates yet
          // because it was not in the selectedNodeId's results
          var vals = [];
          result.forEach(function(val) {
            vals.push({
              sum: val,
              detail: [{
                node: self.nameFromId(id),
                val: val
              }]
            })
          })
          newResponse.aggregates.push(vals)
        }
      })
    })
    callback(nodeNames, entity, newResponse);
  }

module.exports = Topology;