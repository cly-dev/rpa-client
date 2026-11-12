/* DYEH image-slot-fit-policy:v1. Copy this file unchanged to runtime/. */
/* eslint-disable prefer-arrow-callback */
(function (root) {
  'use strict';

  const VERSION = '2.0.1';
  const registrations = new Map();

  function finiteNumber(value, label, positive) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) {
      throw new TypeError(label + (positive ? ' must be a positive finite number' : ' must be a finite number'));
    }
    return value;
  }

  function slotRect(value) {
    if (!value || typeof value !== 'object') {throw new TypeError('slot rect is required');}
    return {
      x: finiteNumber(value.x, 'slot.x', false),
      y: finiteNumber(value.y, 'slot.y', false),
      width: finiteNumber(value.width, 'slot.width', true),
      height: finiteNumber(value.height, 'slot.height', true),
    };
  }

  function fitMode(value) {
    if (value !== 'contain' && value !== 'cover') {
      throw new TypeError('fit must be contain or cover');
    }
    return value;
  }

  function geometry(naturalWidth, naturalHeight, slot, fit) {
    const iw = finiteNumber(naturalWidth, 'naturalWidth', true);
    const ih = finiteNumber(naturalHeight, 'naturalHeight', true);
    const box = slotRect(slot);
    fitMode(fit);
    const scale = fit === 'contain'
      ? Math.min(box.width / iw, box.height / ih)
      : Math.max(box.width / iw, box.height / ih);
    const width = iw * scale;
    const height = ih * scale;
    const crop = fit === 'cover'
      ? {
        top: Math.max(0, (height - box.height) / 2),
        right: Math.max(0, (width - box.width) / 2),
        bottom: Math.max(0, (height - box.height) / 2),
        left: Math.max(0, (width - box.width) / 2),
      }
      : {top: 0, right: 0, bottom: 0, left: 0};
    const rect = {
      x: box.x + (box.width - width) / 2,
      y: box.y + (box.height - height) / 2,
      width: width,
      height: height,
      scale: scale,
      crop: Object.freeze(crop),
    };
    for (const key of ['x', 'y', 'width', 'height', 'scale']) {
      finiteNumber(rect[key], 'image.' + key, key !== 'x' && key !== 'y');
    }
    for (const key of Object.keys(crop)) {finiteNumber(crop[key], 'image.crop.' + key, false);}
    return Object.freeze(rect);
  }

  function localAssetPath(value) {
    if (typeof value !== 'string' || !value || value.startsWith('/') || /[\\:?#%]/.test(value)
      || value.split('/').some(function (part) { return !part || part === '.' || part === '..'; })
      || !/\.(?:png|jpe?g|webp)$/i.test(value)) {
      throw new TypeError('assetPath must be a relative PNG, JPEG, or WebP path');
    }
    return value;
  }

  function mount(options) {
    if (!options || typeof options !== 'object') {throw new TypeError('image slot options are required');}
    const element = options.element;
    const view = element && element.ownerDocument && element.ownerDocument.defaultView;
    const ImageType = root.HTMLImageElement || (view && view.HTMLImageElement);
    let isImage = Boolean(ImageType && element instanceof ImageType);
    if (!isImage && ImageType) {
      // Adopted images can retain a different realm's prototype in Studio.
      // The native getter checks the DOM brand without trusting tagName or a
      // caller-supplied constructor; plain objects and non-images still fail.
      try {
        Object.getOwnPropertyDescriptor(ImageType.prototype, 'naturalWidth').get.call(element);
        isImage = true;
      } catch { /* Not a native HTML image. */ }
    }
    if (!isImage) {throw new TypeError('element must be an HTMLImageElement');}
    const slotId = options.slotId;
    if (typeof slotId !== 'string' || !slotId.trim() || slotId !== slotId.trim()) {
      throw new TypeError('slotId must be a non-empty, unpadded string');
    }
    if (registrations.has(slotId)) {throw new TypeError('slotId is already mounted: ' + slotId);}
    for (const registration of registrations.values()) {
      if (registration.element === element) {throw new TypeError('image element is already mounted');}
    }
    const assetPath = localAssetPath(options.assetPath);
    let box = slotRect(options);
    const fit = fitMode(options.fit);
    if (Object.prototype.hasOwnProperty.call(options, 'focusX')
        || Object.prototype.hasOwnProperty.call(options, 'focusY')) {
      throw new TypeError('custom focus is not supported');
    }
    if (element.parentElement && element.parentElement.tagName === 'PICTURE') {
      throw new TypeError('picture/source substitutions are not supported for image slots');
    }
    if (element.hasAttribute('srcset')) {throw new TypeError('srcset is not supported for image slots');}

    element.setAttribute('data-dyeh-image-slot', slotId);
    element.setAttribute('data-dyeh-asset-path', assetPath);
    element.setAttribute('data-dyeh-adaptation-version', VERSION);
    element.loading = 'eager';
    element.decoding = 'sync';
    const style = element.style;
    Object.assign(style, {
      position: 'absolute', display: 'block', boxSizing: 'content-box',
      maxWidth: 'none', maxHeight: 'none', minWidth: '0', minHeight: '0',
      margin: '0', padding: '0', border: '0', objectFit: 'contain',
      objectPosition: '50% 50%', transform: 'none', clipPath: 'none',
    });

    function apply() {
      element.setAttribute('data-dyeh-slot-rect', JSON.stringify(box));
      element.setAttribute('data-dyeh-fit', fit);
      style.objectFit = 'contain';
      style.objectPosition = '50% 50%';
      if (!element.complete || element.naturalWidth <= 0 || element.naturalHeight <= 0) {return false;}
      const rect = geometry(element.naturalWidth, element.naturalHeight, box, fit);
      style.left = rect.x + 'px';
      style.top = rect.y + 'px';
      style.width = rect.width + 'px';
      style.height = rect.height + 'px';
      style.clipPath = fit === 'cover'
        ? 'inset(' + rect.crop.top + 'px ' + rect.crop.right + 'px '
          + rect.crop.bottom + 'px ' + rect.crop.left + 'px)'
        : 'none';
      return true;
    }

    const ready = new Promise(function (resolve, reject) {
      let settled = false;
      function settle(callback, value) {
        if (settled) {return;}
        settled = true;
        callback(value);
      }
      async function decodeAndApply() {
        const expectedSource = element.getAttribute('src');
        try {
          if (typeof element.decode === 'function') {await element.decode();}
          else if (!element.complete) {return;}
          if (settled) {return;}
          if (element.getAttribute('src') !== expectedSource || expectedSource !== assetPath) {
            throw new Error('image source changed while decoding: ' + slotId);
          }
          if (!apply()) {throw new Error('image decoded without dimensions: ' + slotId);}
          settle(resolve, element);
        } catch (error) {
          settle(reject, error);
        }
      }
      element.addEventListener('load', decodeAndApply);
      element.addEventListener('error', function () {
        settle(reject, new Error('image could not be loaded: ' + slotId + ' (' + assetPath + ')'));
      });
      element.setAttribute('src', assetPath);
      decodeAndApply();
    });
    const registration = Object.freeze({
      element: element,
      ready: ready,
      update: function (changes) {
        if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
          throw new TypeError('image slot update must be an object');
        }
        const nextBox = slotRect(Object.assign({}, box, changes));
        const nextFit = changes.fit === undefined ? fit : fitMode(changes.fit);
        if (nextFit !== fit) {throw new TypeError('fit cannot change after mount');}
        if (Object.prototype.hasOwnProperty.call(changes, 'focusX')
            || Object.prototype.hasOwnProperty.call(changes, 'focusY')) {
          throw new TypeError('custom focus is not supported');
        }
        // Validate the complete update before changing either state or styles.
        box = nextBox;
        apply();
      },
    });
    registrations.set(slotId, registration);
    return registration;
  }

  const api = Object.freeze({
    version: VERSION,
    geometry: geometry,
    mount: mount,
    ready: function () {
      return Promise.all(Array.from(registrations.values(), function (registration) { return registration.ready; }));
    },
  });
  Object.defineProperty(root, 'DyehImageSlot', {value: api, enumerable: true, writable: false, configurable: false});
})(globalThis);
