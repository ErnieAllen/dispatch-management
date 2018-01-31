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

/* global d3 */

var Utilities = {};
Utilities.isAConsole = function (properties, connectionId, nodeType, key) {
  return this.isConsole({
    properties: properties,
    connectionId: connectionId,
    nodeType: nodeType,
    key: key
  });
};
Utilities.isConsole = function (d) {
  return (d && d.properties && d.properties.console_identifier === 'Dispatch console');
};
Utilities.isArtemis = function (d) {
  return (d.nodeType === 'route-container' || d.nodeType === 'on-demand') && (d.properties && d.properties.product === 'apache-activemq-artemis');
};

Utilities.isQpid = function (d) {
  return (d.nodeType === 'route-container' || d.nodeType === 'on-demand') && (d.properties && d.properties.product === 'qpid-cpp');
};
Utilities.flatten = function (attributes, result) {
  var flat = {};
  attributes.forEach(function(attr, i) {
    if (result && result.length > i)
      flat[attr] = result[i];
  });
  return flat;
};
Utilities.copy = function (obj) {
  return JSON.parse(JSON.stringify(obj));
};
Utilities.identity_clean = function (identity) {
  if (!identity)
    return '-';
  var pos = identity.indexOf('/');
  if (pos >= 0)
    return identity.substring(pos + 1);
  return identity;
};
Utilities.addr_text = function (addr) {
  if (!addr)
    return '-';
  if (addr[0] == 'M')
    return addr.substring(2);
  else
    return addr.substring(1);
};
Utilities.addr_class = function (addr) {
  if (!addr) return '-';
  if (addr[0] == 'M') return 'mobile';
  if (addr[0] == 'R') return 'router';
  if (addr[0] == 'A') return 'area';
  if (addr[0] == 'L') return 'local';
  if (addr[0] == 'C') return 'link-incoming';
  if (addr[0] == 'E') return 'link-incoming';
  if (addr[0] == 'D') return 'link-outgoing';
  if (addr[0] == 'F') return 'link-outgoing';
  if (addr[0] == 'T') return 'topo';
  return 'unknown: ' + addr[0];
};
Utilities.humanify = function (s) {
  if (!s || s.length === 0)
    return s;
  var t = s.charAt(0).toUpperCase() + s.substr(1).replace(/[A-Z]/g, ' $&');
  return t.replace('.', ' ');
};
Utilities.pretty = function (v) {
  var formatComma = d3.format(',');
  if (!isNaN(parseFloat(v)) && isFinite(v))
    return formatComma(v);
  return v;
};
Utilities.isMSIE = function () {
  return (document.documentMode || /Edge/.test(navigator.userAgent));
};
Utilities.valFor = function (aAr, vAr, key) {
  var idx = aAr.indexOf(key);
  if ((idx > -1) && (idx < vAr.length)) {
    return vAr[idx];
  }
  return null;
};

module.exports = Utilities;