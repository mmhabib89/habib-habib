/**
 * Automatic bundle (vanilla JS)
 *
 * Intercepts POST requests to /cart/add.js. When the product being added has
 * every configured trigger option value selected (e.g. "Black" and "Medium"),
 * the configured bundle product is added to the cart in the same request.
 *
 * Config is injected on every page via window.automaticBundle (theme.liquid):
 *   {
 *     bundleVariantId: <number>,
 *     triggerValues:   ["Black", "Medium"]
 *   }
 *
 * No dependencies; runs once on load.
 */
(function () {
  'use strict';

  if (window.__automaticBundleInstalled) return;
  window.__automaticBundleInstalled = true;

  var config = window.automaticBundle || window.AutomaticBundle;
  if (!config) return;

  var bundleVariantId = parseInt(config.bundleVariantId, 10);
  if (!bundleVariantId) return;

  var triggerValues = (config.triggerValues || [])
    .map(function (value) {
      return String(value).trim().toLowerCase();
    })
    .filter(Boolean);
  if (!triggerValues.length) return;

  var originalFetch = window.fetch;

  function isCartAddRequest(input) {
    if (typeof input !== 'string') {
      if (input instanceof URL) {
        input = input.href;
      } else if (input && input.url) {
        input = input.url;
      } else {
        return false;
      }
    }
    return /\/cart\/add(\.js)?$/.test(input.split('?')[0]);
  }

  function isOptionField(key) {
    return /^options\[[^\]]+\]$/.test(key) || /^.+-\d+$/.test(key);
  }

  function triggersMatched(optionValues) {
    var lower = optionValues.map(function (value) {
      return String(value).trim().toLowerCase();
    });
    return triggerValues.every(function (triggerValue) {
      return lower.indexOf(triggerValue) !== -1;
    });
  }

  function collectProperties(formData) {
    var properties = {};
    formData.forEach(function (value, key) {
      var match = key.match(/^properties\[(.+)\]$/);
      if (!match) return;
      var name = match[1];
      if (Object.prototype.hasOwnProperty.call(properties, name)) {
        if (!Array.isArray(properties[name])) properties[name] = [properties[name]];
        properties[name].push(value);
      } else {
        properties[name] = value;
      }
    });
    return properties;
  }

  function buildItemsRequest(formData) {
    var mainVariantId = parseInt(formData.get('id'), 10);
    if (!mainVariantId || mainVariantId === bundleVariantId) return null;

    var quantity = parseInt(formData.get('quantity'), 10) || 1;

    var mainItem = {
      id: mainVariantId,
      quantity: quantity,
    };

    var properties = collectProperties(formData);
    if (Object.keys(properties).length) mainItem.properties = properties;

    var payload = {
      items: [mainItem, { id: bundleVariantId, quantity: 1 }],
    };

    var sections = formData.get('sections');
    var sectionsUrl = formData.get('sections_url');
    if (sections) payload.sections = sections;
    if (sectionsUrl) payload.sections_url = sectionsUrl;

    return payload;
  }

  window.fetch = function (input, init) {
    init = init || {};

    var isAdd = isCartAddRequest(input);
    var method = (init.method || 'GET').toUpperCase();

    if (!isAdd || method !== 'POST' || !(init.body instanceof FormData)) {
      return originalFetch.call(this, input, init);
    }

    var optionValues = [];
    init.body.forEach(function (value, key) {
      if (isOptionField(key)) optionValues.push(value);
    });

    if (!triggersMatched(optionValues)) {
      return originalFetch.call(this, input, init);
    }

    var payload = buildItemsRequest(init.body);
    if (!payload) {
      return originalFetch.call(this, input, init);
    }

    var headers = new Headers(init.headers || {});
    headers.set('Content-Type', 'application/json');

    return originalFetch.call(this, input, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
      credentials: init.credentials,
      signal: init.signal,
      cache: init.cache,
      mode: init.mode,
    });
  };
})();