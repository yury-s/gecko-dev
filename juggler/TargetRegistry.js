const {EventEmitter} = ChromeUtils.import('resource://gre/modules/EventEmitter.jsm');
const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {SimpleChannel} = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');
const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const {Preferences} = ChromeUtils.import("resource://gre/modules/Preferences.jsm");
const {ContextualIdentityService} = ChromeUtils.import("resource://gre/modules/ContextualIdentityService.jsm");
const {NetUtil} = ChromeUtils.import('resource://gre/modules/NetUtil.jsm');
const {PageHandler} = ChromeUtils.import("chrome://juggler/content/protocol/PageHandler.js");
const {NetworkHandler} = ChromeUtils.import("chrome://juggler/content/protocol/NetworkHandler.js");
const {RuntimeHandler} = ChromeUtils.import("chrome://juggler/content/protocol/RuntimeHandler.js");
const {AccessibilityHandler} = ChromeUtils.import("chrome://juggler/content/protocol/AccessibilityHandler.js");
const {AppConstants} = ChromeUtils.import("resource://gre/modules/AppConstants.jsm");

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

const helper = new Helper();

const IDENTITY_NAME = 'JUGGLER ';
const HUNDRED_YEARS = 60 * 60 * 24 * 365 * 100;

const ALL_PERMISSIONS = [
  'geo',
  'desktop-notification',
];

class TargetRegistry {
  constructor() {
    EventEmitter.decorate(this);

    this._browserContextIdToBrowserContext = new Map();
    this._userContextIdToBrowserContext = new Map();

    // Cleanup containers from previous runs (if any)
    for (const identity of ContextualIdentityService.getPublicIdentities()) {
      if (identity.name && identity.name.startsWith(IDENTITY_NAME)) {
        ContextualIdentityService.remove(identity.userContextId);
        ContextualIdentityService.closeContainerTabs(identity.userContextId);
      }
    }

    this._defaultContext = new BrowserContext(this, undefined, undefined);

    this._targets = new Map();
    this._tabToTarget = new Map();
    Services.obs.addObserver(this, 'oop-frameloader-crashed');

    const onTabOpenListener = event => {
      const target = this._createTargetForTab(event.target);
      // If we come here, content will have juggler script from the start,
      // and we should wait for initial navigation.
      target._waitForInitialNavigation = true;
      // For pages created before we attach to them, we don't wait for initial
      // navigation (target._waitForInitialNavigation is false by default).
    };

    const onTabCloseListener = event => {
      const tab = event.target;
      const target = this._tabToTarget.get(tab);
      if (!target)
        return;
      this._targets.delete(target.id());
      this._tabToTarget.delete(tab);
      target.dispose();
      this.emit(TargetRegistry.Events.TargetDestroyed, target);
    };

    const wmListener = {
      onOpenWindow: async window => {
        const domWindow = window.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowInternal || Ci.nsIDOMWindow);
        if (!(domWindow instanceof Ci.nsIDOMChromeWindow))
          return;
        await this._waitForWindowLoad(domWindow);
        for (const tab of domWindow.gBrowser.tabs)
          this._createTargetForTab(tab);
        domWindow.gBrowser.tabContainer.addEventListener('TabOpen', onTabOpenListener);
        domWindow.gBrowser.tabContainer.addEventListener('TabClose', onTabCloseListener);
      },
      onCloseWindow: window => {
        const domWindow = window.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowInternal || Ci.nsIDOMWindow);
        if (!(domWindow instanceof Ci.nsIDOMChromeWindow))
          return;
        if (!domWindow.gBrowser)
          return;
        domWindow.gBrowser.tabContainer.removeEventListener('TabOpen', onTabOpenListener);
        domWindow.gBrowser.tabContainer.removeEventListener('TabClose', onTabCloseListener);
        for (const tab of domWindow.gBrowser.tabs)
          onTabCloseListener({ target: tab });
      },
    };
    Services.wm.addListener(wmListener);
  }

  defaultContext() {
    return this._defaultContext;
  }

  createBrowserContext(options) {
    return new BrowserContext(this, helper.generateId(), options);
  }

  browserContextForId(browserContextId) {
    return this._browserContextIdToBrowserContext.get(browserContextId);
  }

  async _waitForWindowLoad(window) {
    if (window.document.readyState === 'complete')
      return;
    await new Promise(fulfill => {
      window.addEventListener('load', function listener() {
        window.removeEventListener('load', listener);
        fulfill();
      });
    });
  }

  async newPage({browserContextId}) {
    let window;
    let created = false;
    const windowsIt = Services.wm.getEnumerator('navigator:browser');
    if (windowsIt.hasMoreElements()) {
      window = windowsIt.getNext();
    } else {
      const features = "chrome,dialog=no,all";
      const args = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
      args.data = 'about:blank';
      window = Services.ww.openWindow(null, AppConstants.BROWSER_CHROME_URL, '_blank', features, args);
      created = true;
    }
    await this._waitForWindowLoad(window);
    const browserContext = this.browserContextForId(browserContextId);
    const tab = window.gBrowser.addTab('about:blank', {
      userContextId: browserContext.userContextId,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    if (created) {
      window.gBrowser.removeTab(window.gBrowser.getTabForBrowser(window.gBrowser.getBrowserAtIndex(0)), {
        skipPermitUnload: true,
      });
    }
    window.gBrowser.selectedTab = tab;
    const target = this._tabToTarget.get(tab);
    await target._contentReadyPromise;
    if (browserContext.options.timezoneId) {
      if (await target.hasFailedToOverrideTimezone())
        throw new Error('Failed to override timezone');
    }
    return target.id();
  }

  targets() {
    return Array.from(this._targets.values());
  }

  targetInfo(targetId) {
    const target = this._targets.get(targetId);
    return target ? target.info() : null;
  }

  tabForTarget(targetId) {
    const target = this._targets.get(targetId);
    if (!target)
      throw new Error(`Target "${targetId}" does not exist!`);
    if (!(target instanceof PageTarget))
      throw new Error(`Target "${targetId}" is not a page!`);
    return target._tab;
  }

  contentChannelForTarget(targetId) {
    const target = this._targets.get(targetId);
    if (!target)
      throw new Error(`Target "${targetId}" does not exist!`);
    if (!(target instanceof PageTarget))
      throw new Error(`Target "${targetId}" is not a page!`);
    return target._channel;
  }

  targetForId(targetId) {
    return this._targets.get(targetId);
  }

  _tabForBrowser(browser) {
    // TODO: replace all of this with browser -> target map.
    const windowsIt = Services.wm.getEnumerator('navigator:browser');
    while (windowsIt.hasMoreElements()) {
      const window = windowsIt.getNext();
      const tab = window.gBrowser.getTabForBrowser(browser);
      if (tab)
        return { tab, gBrowser: window.gBrowser };
    }
  }

  _targetForBrowser(browser) {
    const tab = this._tabForBrowser(browser);
    return tab ? this._tabToTarget.get(tab.tab) : undefined;
  }

  browserContextForBrowser(browser) {
    const tab = this._tabForBrowser(browser);
    return tab ? this._userContextIdToBrowserContext.get(tab.tab.userContextId) : undefined;
  }

  _createTargetForTab(tab) {
    if (this._tabToTarget.has(tab))
      throw new Error(`Internal error: two targets per tab`);
    const openerTarget = tab.openerTab ? this._tabToTarget.get(tab.openerTab) : null;
    const target = new PageTarget(this, tab, this._userContextIdToBrowserContext.get(tab.userContextId), openerTarget);
    this._targets.set(target.id(), target);
    this._tabToTarget.set(tab, target);
    this.emit(TargetRegistry.Events.TargetCreated, target);
    return target;
  }

  observe(subject, topic, data) {
    if (topic === 'oop-frameloader-crashed') {
      const browser = subject.ownerElement;
      if (!browser)
        return;
      const target = this._targetForBrowser(browser);
      if (!target)
        return;
      target.emit('crashed');
      this._targets.delete(target.id());
      this._tabToTarget.delete(target._tab);
      target.dispose();
      this.emit(TargetRegistry.Events.TargetDestroyed, target);
      return;
    }
  }
}

class PageTarget {
  constructor(registry, tab, browserContext, opener) {
    EventEmitter.decorate(this);

    this._targetId = helper.generateId();
    this._registry = registry;
    this._tab = tab;
    this._browserContext = browserContext;
    this._url = '';
    this._openerId = opener ? opener.id() : undefined;
    this._channel = SimpleChannel.createForMessageManager(`browser::page[${this._targetId}]`, tab.linkedBrowser.messageManager);

    const navigationListener = {
      QueryInterface: ChromeUtils.generateQI([ Ci.nsIWebProgressListener]),
      onLocationChange: (aWebProgress, aRequest, aLocation) => this._onNavigated(aLocation),
    };
    this._eventListeners = [
      helper.addProgressListener(tab.linkedBrowser, navigationListener, Ci.nsIWebProgress.NOTIFY_LOCATION),
      helper.addMessageListener(tab.linkedBrowser.messageManager, 'juggler:content-ready', {
        receiveMessage: message => this._onContentReady(message.data)
      }),
    ];

    this._contentReadyPromise = new Promise(f => this._contentReadyCallback = f);
    this._waitForInitialNavigation = false;
    this._disposed = false;

    if (browserContext)
      browserContext.pages.add(this);
    if (browserContext && browserContext.options.viewport)
      this.setViewportSize(browserContext.options.viewport.viewportSize);
  }

  linkedBrowser() {
    return this._tab.linkedBrowser;
  }

  setViewportSize(viewportSize) {
    if (viewportSize) {
      const {width, height} = viewportSize;
      this._tab.linkedBrowser.style.setProperty('min-width', width + 'px');
      this._tab.linkedBrowser.style.setProperty('min-height', height + 'px');
      this._tab.linkedBrowser.style.setProperty('max-width', width + 'px');
      this._tab.linkedBrowser.style.setProperty('max-height', height + 'px');
    } else {
      this._tab.linkedBrowser.style.removeProperty('min-width');
      this._tab.linkedBrowser.style.removeProperty('min-height');
      this._tab.linkedBrowser.style.removeProperty('max-width');
      this._tab.linkedBrowser.style.removeProperty('max-height');
    }
    const rect = this._tab.linkedBrowser.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  connectSession(session) {
    this._initSession(session);
    this._channel.connect('').send('attach', { sessionId: session.sessionId() });
  }

  disconnectSession(session) {
    if (!this._disposed)
      this._channel.connect('').emit('detach', { sessionId: session.sessionId() });
  }

  async close(runBeforeUnload = false) {
    const tab = this._registry._tabForBrowser(this._tab.linkedBrowser);
    await tab.gBrowser.removeTab(this._tab, {
      skipPermitUnload: !runBeforeUnload,
    });
  }

  _initSession(session) {
    const pageHandler = new PageHandler(this, session, this._channel);
    const networkHandler = new NetworkHandler(this, session, this._channel);
    session.registerHandler('Page', pageHandler);
    session.registerHandler('Network', networkHandler);
    session.registerHandler('Runtime', new RuntimeHandler(session, this._channel));
    session.registerHandler('Accessibility', new AccessibilityHandler(session, this._channel));
    pageHandler.enable();
    networkHandler.enable();
  }

  _onContentReady({ userContextId }) {
    // TODO: this is the earliest when userContextId is available.
    // We should create target here, while listening to onContentReady for every tab.
    const sessions = [];
    const data = { sessions, target: this };
    this._registry.emit(TargetRegistry.Events.PageTargetReady, data);
    sessions.forEach(session => this._initSession(session));
    this._contentReadyCallback();
    return {
      browserContextOptions: this._browserContext ? this._browserContext.options : {},
      waitForInitialNavigation: this._waitForInitialNavigation,
      sessionIds: sessions.map(session => session.sessionId()),
    };
  }

  id() {
    return this._targetId;
  }

  info() {
    return {
      targetId: this.id(),
      type: 'page',
      browserContextId: this._browserContext ? this._browserContext.browserContextId : undefined,
      openerId: this._openerId,
    };
  }

  _onNavigated(aLocation) {
    this._url = aLocation.spec;
    this._browserContext.grantPermissionsToOrigin(this._url);
  }

  async ensurePermissions() {
    await this._channel.connect('').send('ensurePermissions', {}).catch(e => void e);
  }

  async addScriptToEvaluateOnNewDocument(script) {
    await this._channel.connect('').send('addScriptToEvaluateOnNewDocument', script).catch(e => void e);
  }

  async addBinding(name, script) {
    await this._channel.connect('').send('addBinding', { name, script }).catch(e => void e);
  }

  async setGeolocationOverride(geolocation) {
    await this._channel.connect('').send('setGeolocationOverride', geolocation).catch(e => void e);
  }

  async setOnlineOverride(override) {
    await this._channel.connect('').send('setOnlineOverride', override).catch(e => void e);
  }

  async hasFailedToOverrideTimezone() {
    return await this._channel.connect('').send('hasFailedToOverrideTimezone').catch(e => true);
  }

  dispose() {
    this._disposed = true;
    if (this._browserContext)
      this._browserContext.pages.delete(this);
    helper.removeListeners(this._eventListeners);
  }
}

class BrowserContext {
  constructor(registry, browserContextId, options) {
    this._registry = registry;
    this.browserContextId = browserContextId;
    // Default context has userContextId === 0, but we pass undefined to many APIs just in case.
    this.userContextId = 0;
    if (browserContextId !== undefined) {
      const identity = ContextualIdentityService.create(IDENTITY_NAME + browserContextId);
      this.userContextId = identity.userContextId;
    }
    this._principals = [];
    // Maps origins to the permission lists.
    this._permissions = new Map();
    this._registry._browserContextIdToBrowserContext.set(this.browserContextId, this);
    this._registry._userContextIdToBrowserContext.set(this.userContextId, this);
    this.options = options || {};
    this.options.scriptsToEvaluateOnNewDocument = [];
    this.options.bindings = [];
    this.pages = new Set();

    if (this.options.ignoreHTTPSErrors) {
      Preferences.set("network.stricttransportsecurity.preloadlist", false);
      Preferences.set("security.cert_pinning.enforcement_level", 0);

      const certOverrideService = Cc[
        "@mozilla.org/security/certoverride;1"
      ].getService(Ci.nsICertOverrideService);
      certOverrideService.setDisableAllSecurityChecksAndLetAttackersInterceptMyData(
        true, this.userContextId
      );
    }
  }

  async destroy() {
    if (this.userContextId !== 0) {
      ContextualIdentityService.remove(this.userContextId);
      ContextualIdentityService.closeContainerTabs(this.userContextId);
      if (this.pages.size) {
        await new Promise(f => {
          const listener = helper.on(this._registry, TargetRegistry.Events.TargetDestroyed, () => {
            if (!this.pages.size) {
              helper.removeListeners([listener]);
              f();
            }
          });
        });
      }
    }
    this._registry._browserContextIdToBrowserContext.delete(this.browserContextId);
    this._registry._userContextIdToBrowserContext.delete(this.userContextId);
  }

  async addScriptToEvaluateOnNewDocument(script) {
    this.options.scriptsToEvaluateOnNewDocument.push(script);
    await Promise.all(Array.from(this.pages).map(page => page.addScriptToEvaluateOnNewDocument(script)));
  }

  async addBinding(name, script) {
    this.options.bindings.push({ name, script });
    await Promise.all(Array.from(this.pages).map(page => page.addBinding(name, script)));
  }

  async setGeolocationOverride(geolocation) {
    this.options.geolocation = geolocation;
    await Promise.all(Array.from(this.pages).map(page => page.setGeolocationOverride(geolocation)));
  }

  async setOnlineOverride(override) {
    this.options.onlineOverride = override;
    await Promise.all(Array.from(this.pages).map(page => page.setOnlineOverride(override)));
  }

  async grantPermissions(origin, permissions) {
    this._permissions.set(origin, permissions);
    const promises = [];
    for (const page of this.pages) {
      if (origin === '*' || page._url.startsWith(origin)) {
        this.grantPermissionsToOrigin(page._url);
        promises.push(page.ensurePermissions());
      }
    }
    await Promise.all(promises);
  }

  resetPermissions() {
    for (const principal of this._principals) {
      for (const permission of ALL_PERMISSIONS)
        Services.perms.removeFromPrincipal(principal, permission);
    }
    this._principals = [];
    this._permissions.clear();
  }

  grantPermissionsToOrigin(url) {
    let origin = Array.from(this._permissions.keys()).find(key => url.startsWith(key));
    if (!origin)
      origin = '*';

    const permissions = this._permissions.get(origin);
    if (!permissions)
      return;

    const attrs = { userContextId: this.userContextId || undefined };
    const principal = Services.scriptSecurityManager.createContentPrincipal(NetUtil.newURI(url), attrs);
    this._principals.push(principal);
    for (const permission of ALL_PERMISSIONS) {
      const action = permissions.includes(permission) ? Ci.nsIPermissionManager.ALLOW_ACTION : Ci.nsIPermissionManager.DENY_ACTION;
      Services.perms.addFromPrincipal(principal, permission, action, Ci.nsIPermissionManager.EXPIRE_NEVER, 0 /* expireTime */);
    }
  }

  setCookies(cookies) {
    const protocolToSameSite = {
      [undefined]: Ci.nsICookie.SAMESITE_NONE,
      'Lax': Ci.nsICookie.SAMESITE_LAX,
      'Strict': Ci.nsICookie.SAMESITE_STRICT,
    };
    for (const cookie of cookies) {
      const uri = cookie.url ? NetUtil.newURI(cookie.url) : null;
      let domain = cookie.domain;
      if (!domain) {
        if (!uri)
          throw new Error('At least one of the url and domain needs to be specified');
        domain = uri.host;
      }
      let path = cookie.path;
      if (!path)
        path = uri ? dirPath(uri.filePath) : '/';
      let secure = false;
      if (cookie.secure !== undefined)
        secure = cookie.secure;
      else if (uri && uri.scheme === 'https')
        secure = true;
      Services.cookies.add(
        domain,
        path,
        cookie.name,
        cookie.value,
        secure,
        cookie.httpOnly || false,
        cookie.expires === undefined || cookie.expires === -1 /* isSession */,
        cookie.expires === undefined ? Date.now() + HUNDRED_YEARS : cookie.expires,
        { userContextId: this.userContextId || undefined } /* originAttributes */,
        protocolToSameSite[cookie.sameSite],
      );
    }
  }

  clearCookies() {
    Services.cookies.removeCookiesWithOriginAttributes(JSON.stringify({ userContextId: this.userContextId || undefined }));
  }

  getCookies() {
    const result = [];
    const sameSiteToProtocol = {
      [Ci.nsICookie.SAMESITE_NONE]: 'None',
      [Ci.nsICookie.SAMESITE_LAX]: 'Lax',
      [Ci.nsICookie.SAMESITE_STRICT]: 'Strict',
    };
    for (let cookie of Services.cookies.cookies) {
      if (cookie.originAttributes.userContextId !== this.userContextId)
        continue;
      if (cookie.host === 'addons.mozilla.org')
        continue;
      result.push({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.host,
        path: cookie.path,
        expires: cookie.isSession ? -1 : cookie.expiry,
        size: cookie.name.length + cookie.value.length,
        httpOnly: cookie.isHttpOnly,
        secure: cookie.isSecure,
        session: cookie.isSession,
        sameSite: sameSiteToProtocol[cookie.sameSite],
      });
    }
    return result;
  }
}

function dirPath(path) {
  return path.substring(0, path.lastIndexOf('/') + 1);
}

TargetRegistry.Events = {
  TargetCreated: Symbol('TargetRegistry.Events.TargetCreated'),
  TargetDestroyed: Symbol('TargetRegistry.Events.TargetDestroyed'),
  PageTargetReady: Symbol('TargetRegistry.Events.PageTargetReady'),
};

var EXPORTED_SYMBOLS = ['TargetRegistry'];
this.TargetRegistry = TargetRegistry;
