"use strict";

const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const helper = new Helper();

class RuntimeHandler {
  constructor(chromeSession, sessionId, contentChannel) {
    this._chromeSession = chromeSession;
    this._contentRuntime = contentChannel.connect(sessionId + 'runtime');

    const emitProtocolEvent = eventName => {
      return (...args) => this._chromeSession.emitEvent(eventName, ...args);
    }

    this._eventListeners = [
      contentChannel.register(sessionId + 'runtime', {
        runtimeConsole: emitProtocolEvent('Runtime.console'),
        runtimeExecutionContextCreated: emitProtocolEvent('Runtime.executionContextCreated'),
        runtimeExecutionContextDestroyed: emitProtocolEvent('Runtime.executionContextDestroyed'),
      }),
    ];
  }

  async evaluate(options) {
    return await this._contentRuntime.send('evaluate', options);
  }

  async callFunction(options) {
    return await this._contentRuntime.send('callFunction', options);
  }

  async getObjectProperties(options) {
    return await this._contentRuntime.send('getObjectProperties', options);
  }

  async disposeObject(options) {
    return await this._contentRuntime.send('disposeObject', options);
  }

  dispose() {
    this._contentRuntime.dispose();
    helper.removeListeners(this._eventListeners);
  }
}

var EXPORTED_SYMBOLS = ['RuntimeHandler'];
this.RuntimeHandler = RuntimeHandler;
