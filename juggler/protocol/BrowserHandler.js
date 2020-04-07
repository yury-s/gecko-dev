"use strict";

const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const {TargetRegistry} = ChromeUtils.import("chrome://juggler/content/TargetRegistry.js");
const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');

const helper = new Helper();

class BrowserHandler {
  constructor(session, dispatcher, targetRegistry, onclose) {
    this._session = session;
    this._dispatcher = dispatcher;
    this._targetRegistry = targetRegistry;
    this._enabled = false;
    this._attachToDefaultContext = false;
    this._eventListeners = [];
    this._createdBrowserContextIds = new Set();
    this._attachedSessions = new Map();
    this._onclose = onclose;
  }

  async enable({attachToDefaultContext}) {
    if (this._enabled)
      return;
    this._enabled = true;
    this._attachToDefaultContext = attachToDefaultContext;

    for (const target of this._targetRegistry.targets()) {
      if (!this._shouldAttachToTarget(target))
        continue;
      const session = this._dispatcher.createSession();
      target.connectSession(session);
      this._attachedSessions.set(target, session);
      this._session.emitEvent('Browser.attachedToTarget', {
        sessionId: session.sessionId(),
        targetInfo: target.info()
      });
    }

    this._eventListeners = [
      helper.on(this._targetRegistry, TargetRegistry.Events.TargetCreated, this._onTargetCreated.bind(this)),
      helper.on(this._targetRegistry, TargetRegistry.Events.TargetDestroyed, this._onTargetDestroyed.bind(this)),
      helper.on(this._targetRegistry, TargetRegistry.Events.DownloadCreated, this._onDownloadCreated.bind(this)),
      helper.on(this._targetRegistry, TargetRegistry.Events.DownloadFinished, this._onDownloadFinished.bind(this)),
    ];
  }

  async createBrowserContext(options) {
    if (!this._enabled)
      throw new Error('Browser domain is not enabled');
    const browserContext = this._targetRegistry.createBrowserContext(options);
    this._createdBrowserContextIds.add(browserContext.browserContextId);
    return {browserContextId: browserContext.browserContextId};
  }

  async removeBrowserContext({browserContextId}) {
    if (!this._enabled)
      throw new Error('Browser domain is not enabled');
    await this._targetRegistry.browserContextForId(browserContextId).destroy();
    this._createdBrowserContextIds.delete(browserContextId);
  }

  dispose() {
    helper.removeListeners(this._eventListeners);
    for (const [target, session] of this._attachedSessions) {
      target.disconnectSession(session);
      this._dispatcher.destroySession(session);
    }
    this._attachedSessions.clear();
    for (const browserContextId of this._createdBrowserContextIds) {
      const browserContext = this._targetRegistry.browserContextForId(browserContextId);
      if (browserContext.options.removeOnDetach)
        browserContext.destroy();
    }
    this._createdBrowserContextIds.clear();
  }

  _shouldAttachToTarget(target) {
    if (!target._browserContext)
      return false;
    if (this._createdBrowserContextIds.has(target._browserContext.browserContextId))
      return true;
    return this._attachToDefaultContext && target._browserContext === this._targetRegistry.defaultContext();
  }

  _onTargetCreated({sessions, target}) {
    if (!this._shouldAttachToTarget(target))
      return;
    const session = this._dispatcher.createSession();
    this._attachedSessions.set(target, session);
    this._session.emitEvent('Browser.attachedToTarget', {
      sessionId: session.sessionId(),
      targetInfo: target.info()
    });
    sessions.push(session);
  }

  _onTargetDestroyed(target) {
    const session = this._attachedSessions.get(target);
    if (!session)
      return;
    this._attachedSessions.delete(target);
    this._dispatcher.destroySession(session);
    this._session.emitEvent('Browser.detachedFromTarget', {
      sessionId: session.sessionId(),
      targetId: target.id(),
    });
  }

  _onDownloadCreated(downloadInfo) {
    this._session.emitEvent('Browser.downloadCreated', downloadInfo);
  }

  _onDownloadFinished(downloadInfo) {
    this._session.emitEvent('Browser.downloadFinished', downloadInfo);
  }

  async newPage({browserContextId}) {
    const targetId = await this._targetRegistry.newPage({browserContextId});
    return {targetId};
  }

  async close() {
    this._onclose();
    let browserWindow = Services.wm.getMostRecentWindow(
      "navigator:browser"
    );
    if (browserWindow && browserWindow.gBrowserInit) {
      await browserWindow.gBrowserInit.idleTasksFinishedPromise;
    }
    Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
  }

  async grantPermissions({browserContextId, origin, permissions}) {
    await this._targetRegistry.browserContextForId(browserContextId).grantPermissions(origin, permissions);
  }

  resetPermissions({browserContextId}) {
    this._targetRegistry.browserContextForId(browserContextId).resetPermissions();
  }

  setExtraHTTPHeaders({browserContextId, headers}) {
    this._targetRegistry.browserContextForId(browserContextId).options.extraHTTPHeaders = headers;
  }

  setHTTPCredentials({browserContextId, credentials}) {
    this._targetRegistry.browserContextForId(browserContextId).options.httpCredentials = credentials;
  }

  setRequestInterception({browserContextId, enabled}) {
    this._targetRegistry.browserContextForId(browserContextId).options.requestInterceptionEnabled = enabled;
  }

  async setGeolocationOverride({browserContextId, geolocation}) {
    await this._targetRegistry.browserContextForId(browserContextId).setGeolocationOverride(geolocation);
  }

  async setOnlineOverride({browserContextId, override}) {
    await this._targetRegistry.browserContextForId(browserContextId).setOnlineOverride(override);
  }

  async setColorScheme({browserContextId, colorScheme}) {
    await this._targetRegistry.browserContextForId(browserContextId).setColorScheme(colorScheme);
  }

  async addScriptToEvaluateOnNewDocument({browserContextId, script}) {
    await this._targetRegistry.browserContextForId(browserContextId).addScriptToEvaluateOnNewDocument(script);
  }

  async addBinding({browserContextId, name, script}) {
    await this._targetRegistry.browserContextForId(browserContextId).addBinding(name, script);
  }

  setCookies({browserContextId, cookies}) {
    this._targetRegistry.browserContextForId(browserContextId).setCookies(cookies);
  }

  clearCookies({browserContextId}) {
    this._targetRegistry.browserContextForId(browserContextId).clearCookies();
  }

  getCookies({browserContextId}) {
    const cookies = this._targetRegistry.browserContextForId(browserContextId).getCookies();
    return {cookies};
  }

  async getInfo() {
    const version = Components.classes["@mozilla.org/xre/app-info;1"]
                              .getService(Components.interfaces.nsIXULAppInfo)
                              .version;
    const userAgent = Components.classes["@mozilla.org/network/protocol;1?name=http"]
                                .getService(Components.interfaces.nsIHttpProtocolHandler)
                                .userAgent;
    return {version: 'Firefox/' + version, userAgent};
  }
}

var EXPORTED_SYMBOLS = ['BrowserHandler'];
this.BrowserHandler = BrowserHandler;
